import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { AuthorizationEntryView, AuthorizationEvent } from '@deepseek-ai/dsh-api-remotes/client'
import { createModelsOperations } from '../src/client/operations.ts'

const KEY = 'llm-pi-ai/anthropic-oauth'
const entry = (overrides: Partial<AuthorizationEntryView> = {}): AuthorizationEntryView => ({
  key: KEY, label: 'anthropicOauth', methods: [{ id: 'oauth', label: 'Sign in' }], inFlight: false, signedIn: false, ...overrides,
})

/** A stream handle that yields scripted events, or throws partway through. */
function handle(events: AuthorizationEvent[], failure?: Error) {
  const dispose = vi.fn()
  return {
    dispose,
    send: vi.fn(),
    end: vi.fn(),
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event
      if (failure !== undefined) throw failure
    },
  }
}

function ctxWith(authorization: object) {
  return Object.assign(new Context(), { remote: { authorization } })
}

describe('the authorization operations the sign-in card calls', () => {
  it('finds the flow for a route by its credential key suffix and reports its status', async () => {
    const list = vi.fn(async () => ({ ok: true, value: [entry({ key: 'llm-pi-ai/anthropic' }), entry({ signedIn: true, inFlight: true })] }))
    const { authorization } = createModelsOperations(ctxWith({ list }))
    await expect(authorization!.status('anthropic-oauth')).resolves.toEqual({ key: KEY, signedIn: true, inFlight: true })
    await expect(authorization!.status('no-such-route')).resolves.toBeUndefined()
  })

  it('reports no status when the list is refused', async () => {
    const list = vi.fn(async () => ({ ok: false, error: { code: 'gateway/internal', message: 'absent', details: {} } }))
    const { authorization } = createModelsOperations(ctxWith({ list }))
    await expect(authorization!.status('anthropic-oauth')).resolves.toBeUndefined()
  })

  it('forwards stream events and resolves with the settled status', async () => {
    const events: AuthorizationEvent[] = [
      { type: 'notice', message: 'Open it', url: 'https://auth.example' },
      { type: 'settled', status: 'authorized' },
    ]
    const begin = vi.fn(() => handle(events))
    const { authorization } = createModelsOperations(ctxWith({ begin }))
    const seen: AuthorizationEvent[] = []
    const signal = new AbortController().signal
    await expect(authorization!.signIn(KEY, event => seen.push(event), signal)).resolves.toEqual({ status: 'authorized' })
    expect(seen).toEqual(events)
    expect(begin).toHaveBeenCalledWith(KEY, undefined, signal)
  })

  it('turns a stream failure into a failed outcome carrying the message', async () => {
    const { authorization } = createModelsOperations(ctxWith({ begin: () => handle([], new Error('already running')) }))
    await expect(authorization!.signIn(KEY, () => {}, new AbortController().signal)).resolves.toEqual({ failed: 'already running' })
  })

  it('turns a non-Error failure into a failed outcome too', async () => {
    const stream = {
      dispose: vi.fn(),
      // eslint-disable-next-line require-yield
      async *[Symbol.asyncIterator]() { throw 'plain' },
    }
    const { authorization } = createModelsOperations(ctxWith({ begin: () => stream }))
    await expect(authorization!.signIn(KEY, () => {}, new AbortController().signal)).resolves.toEqual({ failed: 'plain' })
  })

  it('reports cancelled when the stream ends without settling', async () => {
    const { authorization } = createModelsOperations(ctxWith({ begin: () => handle([{ type: 'notice', message: 'x' }]) }))
    await expect(authorization!.signIn(KEY, () => {}, new AbortController().signal)).resolves.toEqual({ status: 'cancelled' })
  })

  it('returns the refusal message of an answer, a cancel and a sign-out, or undefined when done', async () => {
    const refuse = async () => ({ ok: false, error: { code: 'gateway/bad-request', message: 'refused', details: {} } })
    const accept = async () => ({ ok: true, value: undefined })
    const refusing = createModelsOperations(ctxWith({ answer: refuse, cancel: refuse, signOut: refuse })).authorization!
    const accepting = createModelsOperations(ctxWith({ answer: accept, cancel: accept, signOut: accept })).authorization!
    await expect(refusing.answer(KEY, 'p1', 'code')).resolves.toBe('refused')
    await expect(refusing.cancel(KEY)).resolves.toBe('refused')
    await expect(refusing.signOut(KEY)).resolves.toBe('refused')
    await expect(accepting.answer(KEY, 'p1', 'code')).resolves.toBeUndefined()
    await expect(accepting.cancel(KEY)).resolves.toBeUndefined()
    await expect(accepting.signOut(KEY)).resolves.toBeUndefined()
  })
})
