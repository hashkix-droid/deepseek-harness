// @vitest-environment jsdom
/** The OAuth sign-in card: status, the link and code a flow shows, questions, cancellation, and sign-out. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthorizationEvent } from '@deepseek-ai/dsh-api-remotes/client'
import { OAuthSignInCard } from '../src/client/OAuthSignInCard.tsx'
import type { AuthorizationOperations, SignInOutcome } from '../src/client/operations.ts'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const KEY = 'llm-pi-ai/anthropic-oauth'
const t = (key: keyof typeof en): string => en[key]
const OUT: { signedIn: boolean; inFlight: boolean } = { signedIn: false, inFlight: false }

/** Operations whose sign-in stays open until the test settles it. */
function harness(initial: { signedIn: boolean; inFlight: boolean } | null = OUT) {
  const state = { current: initial }
  let emit: (event: AuthorizationEvent) => void = () => {}
  let settle: (outcome: SignInOutcome) => void = () => {}
  let signal: AbortSignal | undefined
  const status = vi.fn(() => Promise.resolve(state.current === null ? undefined : { key: KEY, ...state.current }))
  const signIn = vi.fn((_key: string, on: (event: AuthorizationEvent) => void, abort: AbortSignal) => {
    emit = on
    signal = abort
    return new Promise<SignInOutcome>((resolve) => { settle = resolve })
  })
  const answer = vi.fn((..._call: [string, string, string]) => Promise.resolve<string | undefined>(undefined))
  const cancel = vi.fn(() => Promise.resolve<string | undefined>(undefined))
  const signOut = vi.fn((_key: string) => Promise.resolve<string | undefined>(undefined))
  const operations: AuthorizationOperations = { status, signIn, answer, cancel, signOut }
  return {
    status,
    signIn,
    answer,
    signOut,
    state,
    operations,
    emit: (event: AuthorizationEvent) => { act(() => { emit(event) }) },
    settle: async (outcome: SignInOutcome) => { await act(async () => { settle(outcome) }) },
    signal: () => signal,
  }
}

async function open(h: ReturnType<typeof harness>, disabled = false) {
  render(<OAuthSignInCard route="anthropic-oauth" operations={h.operations} t={t} disabled={disabled} />)
  await screen.findByText(en.oauthSignedOut, {}, { timeout: 1000 }).catch(() => undefined)
}

const signInButton = () => screen.getByRole('button', { name: en.oauthSignIn })

describe('the OAuth sign-in card', () => {
  it('renders nothing when no flow serves the route', async () => {
    const h = harness(null)
    const { container } = render(<OAuthSignInCard route="anthropic-oauth" operations={h.operations} t={t} />)
    await waitFor(() => { expect(h.status).toHaveBeenCalledWith('anthropic-oauth') })
    expect(container.textContent).toBe('')
  })

  it('shows Sign in while signed out', async () => {
    const h = harness()
    await open(h)
    expect(screen.getByText(en.oauthSignedOut)).toBeTruthy()
    expect(signInButton()).toBeTruthy()
  })

  it('shows the link with Open and Copy while waiting, and a copied acknowledgement', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const h = harness()
    await open(h)
    fireEvent.click(signInButton())
    h.emit({ type: 'notice', message: 'Approve it in your browser', url: 'https://auth.example/start' })

    expect(await screen.findByText('Approve it in your browser')).toBeTruthy()
    expect(screen.getByText(en.oauthWaiting)).toBeTruthy()
    const link = screen.getByRole('link', { name: en.oauthOpenLink })
    expect(link.getAttribute('href')).toBe('https://auth.example/start')
    expect(link.getAttribute('rel')).toContain('noopener')
    fireEvent.click(screen.getByRole('button', { name: en.oauthCopyLink }))
    expect(await screen.findByText(en.oauthCopied)).toBeTruthy()
    expect(writeText).toHaveBeenCalledWith('https://auth.example/start')
  })

  it('survives a clipboard that refuses the copy', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) }, configurable: true })
    const h = harness()
    await open(h)
    fireEvent.click(signInButton())
    h.emit({ type: 'notice', message: 'Open it', url: 'https://auth.example/start' })
    fireEvent.click(await screen.findByRole('button', { name: en.oauthCopyLink }))
    await waitFor(() => { expect(screen.queryByText(en.oauthCopied)).toBeNull() })
    expect(screen.getByRole('button', { name: en.oauthCopyLink })).toBeTruthy()
  })

  it('refuses to render a link that is not http(s)', async () => {
    const h = harness()
    await open(h)
    fireEvent.click(signInButton())
    h.emit({ type: 'notice', message: 'Click me', url: 'javascript:alert(1)' })
    expect(await screen.findByText('Click me')).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByRole('button', { name: en.oauthCopyLink })).toBeNull()
  })

  it('shows a device code', async () => {
    const h = harness()
    await open(h)
    fireEvent.click(signInButton())
    h.emit({ type: 'notice', message: 'Enter the code', url: 'https://device.example', code: 'WXYZ-1234' })
    expect(await screen.findByText('Code: WXYZ-1234')).toBeTruthy()
  })

  it('answers a text question and clears it', async () => {
    const h = harness()
    await open(h)
    fireEvent.click(signInButton())
    h.emit({ type: 'prompt', promptId: 'p1', kind: 'text', message: 'Paste the code', placeholder: 'code' })
    const field = await screen.findByLabelText('Paste the code')
    const submit = screen.getByRole('button', { name: en.oauthSubmit })
    expect((submit as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(field, { target: { value: ' the-code ' } })
    fireEvent.click(submit)
    await waitFor(() => { expect(h.answer).toHaveBeenCalledWith(KEY, 'p1', 'the-code') })
    await waitFor(() => { expect(screen.queryByLabelText('Paste the code')).toBeNull() })
  })

  it('masks a secret question and answers a select question by option id', async () => {
    const h = harness()
    await open(h)
    fireEvent.click(signInButton())
    h.emit({ type: 'prompt', promptId: 'p1', kind: 'secret', message: 'Key' })
    expect((await screen.findByLabelText('Key')).getAttribute('type')).toBe('password')
    h.emit({ type: 'prompt', promptId: 'p2', kind: 'select', message: 'Pick', options: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }] })
    const select = await screen.findByLabelText('Pick')
    fireEvent.change(select, { target: { value: 'b' } })
    fireEvent.click(screen.getByRole('button', { name: en.oauthSubmit }))
    await waitFor(() => { expect(h.answer).toHaveBeenCalledWith(KEY, 'p2', 'b') })
  })

  it('offers an empty choice for a select question that lists no options', async () => {
    const h = harness()
    await open(h)
    fireEvent.click(signInButton())
    h.emit({ type: 'prompt', promptId: 'p1', kind: 'select', message: 'Pick' })
    expect((await screen.findByLabelText<HTMLSelectElement>('Pick')).options).toHaveLength(1)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.oauthSubmit }).disabled).toBe(true)
  })

  it('shows the Host refusal when an answer is not delivered', async () => {
    const h = harness()
    h.answer.mockResolvedValue('no such question is waiting for an answer')
    await open(h)
    fireEvent.click(signInButton())
    h.emit({ type: 'prompt', promptId: 'p1', kind: 'text', message: 'Paste the code' })
    fireEvent.change(await screen.findByLabelText('Paste the code'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: en.oauthSubmit }))
    expect(await screen.findByText('Sign-in failed: no such question is waiting for an answer')).toBeTruthy()
  })

  it('shows signed in with Sign out once authorized, and signs out', async () => {
    const h = harness()
    await open(h)
    fireEvent.click(signInButton())
    h.state.current = { signedIn: true, inFlight: false }
    h.emit({ type: 'settled', status: 'authorized' })
    await h.settle({ status: 'authorized' })
    expect(await screen.findByText(en.oauthSignedIn)).toBeTruthy()
    h.state.current = { signedIn: false, inFlight: false }
    fireEvent.click(screen.getByRole('button', { name: en.oauthSignOut }))
    await waitFor(() => { expect(h.signOut).toHaveBeenCalledWith(KEY) })
    expect(await screen.findByText(en.oauthSignedOut)).toBeTruthy()
  })

  it('shows the Host refusal when sign-out is refused', async () => {
    const h = harness({ signedIn: true, inFlight: false })
    h.signOut.mockResolvedValue('the store is read-only')
    render(<OAuthSignInCard route="anthropic-oauth" operations={h.operations} t={t} />)
    fireEvent.click(await screen.findByRole('button', { name: en.oauthSignOut }))
    expect(await screen.findByText('Sign-in failed: the store is read-only')).toBeTruthy()
  })

  it('shows a failure with Try again, which starts a new attempt', async () => {
    const h = harness()
    await open(h)
    fireEvent.click(signInButton())
    await h.settle({ failed: 'the provider said no' })
    expect(await screen.findByText('Sign-in failed: the provider said no')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.oauthRetry }))
    await waitFor(() => { expect(h.signIn).toHaveBeenCalledTimes(2) })
  })

  it('withdraws the attempt when Cancel is pressed and returns to signed out', async () => {
    const h = harness()
    await open(h)
    fireEvent.click(signInButton())
    fireEvent.click(await screen.findByRole('button', { name: en.cancel }))
    expect(h.signal()?.aborted).toBe(true)
    await h.settle({ status: 'cancelled' })
    expect(await screen.findByText(en.oauthSignedOut)).toBeTruthy()
  })

  it('cancels a running attempt when the card unmounts', async () => {
    const h = harness()
    await open(h)
    fireEvent.click(signInButton())
    cleanup()
    expect(h.signal()?.aborted).toBe(true)
  })

  it('says a sign-in is already in progress instead of starting a second one', async () => {
    const h = harness({ signedIn: false, inFlight: true })
    await open(h)
    fireEvent.click(signInButton())
    expect(await screen.findByText(en.oauthInFlight)).toBeTruthy()
    expect(h.signIn).not.toHaveBeenCalled()
  })

  it('starts when the in-progress state it read has since ended', async () => {
    const h = harness({ signedIn: false, inFlight: true })
    await open(h)
    h.state.current = { signedIn: false, inFlight: false }
    fireEvent.click(signInButton())
    await waitFor(() => { expect(h.signIn).toHaveBeenCalledTimes(1) })
    expect(screen.queryByText(en.oauthInFlight)).toBeNull()
  })

  it('reports an in-progress sign-in, not a failure, when the Host refused because another attempt runs', async () => {
    const h = harness()
    await open(h)
    fireEvent.click(signInButton())
    h.state.current = { signedIn: false, inFlight: true }
    await h.settle({ failed: 'an authorization attempt is already running' })
    expect(await screen.findByText(en.oauthInFlight)).toBeTruthy()
    expect(screen.queryByText(/Sign-in failed/)).toBeNull()
  })

  it('disables its buttons while the page is read-only', async () => {
    const h = harness()
    await open(h, true)
    expect((signInButton() as HTMLButtonElement).disabled).toBe(true)
  })
})
