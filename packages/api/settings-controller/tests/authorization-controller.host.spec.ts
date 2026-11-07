import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import type { AuthorizationFlow, AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import AuthorizationController from '../src/authorization.ts'
import type { AuthorizationEvent } from '../src/types.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'

const KEY = credentialKey('llm-pi-ai', 'anthropic-oauth')
const SECRET = 'sentinel-access-token'

/** A flow that notifies, asks one question, then commits a grant carrying {@link SECRET}. */
function flow(ctx: Context, run?: (session: AuthorizationSession) => Promise<void>): AuthorizationFlow {
  return {
    key: KEY,
    label: 'anthropicOauth',
    methods: [{ id: 'oauth', label: 'Sign in' }],
    async run(session) {
      if (run !== undefined) return run(session)
      session.notify({ message: 'Open the page', url: 'https://auth.example/start' })
      const code = await session.prompt({ kind: 'text', message: 'Paste the code', placeholder: 'code' })
      await session.commit({ kind: 'grant', payload: { access: SECRET, code } })
    },
  }
}

async function boot(run?: (session: AuthorizationSession) => Promise<void>): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(AuthorizationService)
  ctx.authorization.registerFlow(flow(ctx, run))
  await ctx.plugin(AuthorizationController)
  return ctx
}

async function drain(stream: AsyncIterable<AuthorizationEvent>): Promise<AuthorizationEvent[]> {
  const events: AuthorizationEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

describe('the authorization Remote namespace a configuration surface calls', () => {
  it('publishes the authorization namespace with one stream method', async () => {
    const ctx = await boot()
    const controller = ctx.authorizationController
    expect(controller.typertRemote.namespace).toBe('authorization')
    expect(remoteMethods(controller).map(marker => marker.method)).toEqual(['list', 'begin', 'answer', 'cancel', 'signOut'])
    expect(remoteMethods(controller).find(marker => marker.method === 'begin')?.mode).toBe('stream')
  })

  it('lists flows with signed-in status and never a secret', async () => {
    const ctx = await boot()
    const controller = ctx.authorizationController
    expect(await controller.list()).toEqual([{
      key: KEY, label: 'anthropicOauth', methods: [{ id: 'oauth', label: 'Sign in' }], inFlight: false, signedIn: false,
    }])
    await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: { access: SECRET } }))
    const listed = await controller.list()
    expect(listed[0]?.signedIn).toBe(true)
    expect(JSON.stringify(listed)).not.toContain(SECRET)
  })

  it('streams notices and prompts, resolves an answer, and settles authorized', async () => {
    const ctx = await boot()
    const controller = ctx.authorizationController
    const events: AuthorizationEvent[] = []
    for await (const event of controller.begin(KEY, undefined, new AbortController().signal)) {
      events.push(event)
      if (event.type === 'prompt') await controller.answer(KEY, event.promptId, 'the-code')
    }
    expect(events.map(event => event.type)).toEqual(['notice', 'prompt', 'settled'])
    expect(events[0]).toEqual({ type: 'notice', message: 'Open the page', url: 'https://auth.example/start' })
    expect(events[1]).toMatchObject({ type: 'prompt', kind: 'text', message: 'Paste the code', placeholder: 'code' })
    expect(events[2]).toEqual({ type: 'settled', status: 'authorized' })
    expect(JSON.stringify(events)).not.toContain(SECRET)
    expect((await controller.list())[0]).toMatchObject({ signedIn: true, inFlight: false })
  })

  it('carries select prompt options and secret placeholders', async () => {
    const ctx = await boot(async (session) => {
      await session.prompt({ kind: 'select', message: 'Pick', options: [{ id: 'a', label: 'A' }] })
      await session.prompt({ kind: 'secret', message: 'Key', placeholder: 'sk-' })
      await session.commit({ kind: 'grant', payload: { access: SECRET } })
    })
    const controller = ctx.authorizationController
    const prompts: AuthorizationEvent[] = []
    for await (const event of controller.begin(KEY, 'oauth', new AbortController().signal)) {
      if (event.type !== 'prompt') continue
      prompts.push(event)
      await controller.answer(KEY, event.promptId, 'a')
    }
    expect(prompts).toMatchObject([
      { kind: 'select', options: [{ id: 'a', label: 'A' }] },
      { kind: 'secret', placeholder: 'sk-' },
    ])
  })

  it('settles cancelled when the caller aborts mid-prompt and frees the key', async () => {
    const ctx = await boot()
    const controller = ctx.authorizationController
    const abort = new AbortController()
    const events: AuthorizationEvent[] = []
    for await (const event of controller.begin(KEY, undefined, abort.signal)) {
      events.push(event)
      if (event.type === 'prompt') abort.abort()
    }
    expect(events.at(-1)).toEqual({ type: 'settled', status: 'cancelled' })
    expect((await controller.list())[0]?.inFlight).toBe(false)
  })

  it('cancels a running attempt on request', async () => {
    const ctx = await boot()
    const controller = ctx.authorizationController
    const events: AuthorizationEvent[] = []
    for await (const event of controller.begin(KEY, undefined, new AbortController().signal)) {
      events.push(event)
      if (event.type === 'prompt') await controller.cancel(KEY)
    }
    expect(events.at(-1)).toEqual({ type: 'settled', status: 'cancelled' })
  })

  it('refuses a second begin while one is running, with the seam message', async () => {
    const ctx = await boot()
    const controller = ctx.authorizationController
    const first = controller.begin(KEY, undefined, new AbortController().signal)[Symbol.asyncIterator]()
    await first.next()
    const failure = await drain(controller.begin(KEY, undefined, new AbortController().signal)).catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'authorization/failed' })
    expect(remoteErrorOf(failure)?.message).toContain('already running')
    await first.return?.()
  })

  it('reports a flow failure as authorization/failed with its message', async () => {
    const ctx = await boot(() => Promise.reject(new Error('the provider said no')))
    const failure = await drain(ctx.authorizationController.begin(KEY, undefined, new AbortController().signal))
      .catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'authorization/failed', message: 'the provider said no' })
  })

  it('reports a flow that rejects with a bare string', async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- some client libraries reject with a string
    const ctx = await boot(() => Promise.reject('plain refusal'))
    const failure = await drain(ctx.authorizationController.begin(KEY, undefined, new AbortController().signal))
      .catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'authorization/failed', message: 'plain refusal' })
  })

  it('refuses an unknown key, an unknown prompt id, and a key outside the grammar', async () => {
    const ctx = await boot()
    const controller = ctx.authorizationController
    for (const call of [
      () => drain(controller.begin('nope', undefined, new AbortController().signal)),
      () => controller.answer(KEY, 'no-such-prompt', 'x'),
      () => controller.cancel('nope'),
      () => controller.signOut('nope'),
    ]) {
      expect(remoteErrorOf(await call().catch((error: unknown) => error))).toMatchObject({ code: 'gateway/bad-request' })
    }
  })

  it('signs out by deleting the record, idempotently', async () => {
    const ctx = await boot()
    const controller = ctx.authorizationController
    await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: { access: SECRET } }))
    await controller.signOut(KEY)
    await controller.signOut(KEY)
    expect((await controller.list())[0]?.signedIn).toBe(false)
  })

  it('relays a device code notice and a notice without a link', async () => {
    const ctx = await boot(async (session) => {
      session.notify({ message: 'Enter the code', url: 'https://device.example', code: 'WXYZ-1234' })
      session.notify({ message: 'Working' })
      await session.commit({ kind: 'grant', payload: { access: SECRET } })
    })
    const events = await drain(ctx.authorizationController.begin(KEY, undefined, new AbortController().signal))
    expect(events.slice(0, 2)).toEqual([
      { type: 'notice', message: 'Enter the code', url: 'https://device.example', code: 'WXYZ-1234' },
      { type: 'notice', message: 'Working' },
    ])
  })

  it('withdraws one question when its own signal aborts, leaving the attempt running', async () => {
    const withdrawn = new AbortController()
    const ctx = await boot(async (session) => {
      const race = session.prompt({ kind: 'text', message: 'Paste', signal: withdrawn.signal }).catch(() => 'withdrawn')
      withdrawn.abort(new Error('losing prompt'))
      expect(await race).toBe('withdrawn')
      await session.commit({ kind: 'grant', payload: { access: SECRET } })
    })
    const events = await drain(ctx.authorizationController.begin(KEY, undefined, new AbortController().signal))
    expect(events.at(-1)).toEqual({ type: 'settled', status: 'authorized' })
  })

  it('rejects an oversized answer as a bad request', async () => {
    const ctx = await boot()
    const failure = await ctx.authorizationController.answer(KEY, 'p1', 'x'.repeat(20_000)).catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'gateway/bad-request' })
  })

  it('reports a refused sign-out with the message of the store', async () => {
    class RefusingDelete extends MemoryCredentials {
      override deleteRecord(): Promise<void> { return Promise.reject(new Error('the store is read-only')) }
    }
    const ctx = new Context()
    await ctx.plugin(RefusingDelete)
    await ctx.plugin(AuthorizationService)
    ctx.authorization.registerFlow(flow(ctx))
    await ctx.plugin(AuthorizationController)
    const failure = await ctx.authorizationController.signOut(KEY).catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'authorization/failed', message: 'the store is read-only' })
  })

  it('reports the actionable error while the authorization service is absent', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryCredentials)
    await ctx.plugin(AuthorizationController)
    for (const call of [
      () => ctx.authorizationController.list(),
      () => drain(ctx.authorizationController.begin(KEY, undefined, new AbortController().signal)),
      () => ctx.authorizationController.answer(KEY, 'p', 'x'),
      () => ctx.authorizationController.cancel(KEY),
      () => ctx.authorizationController.signOut(KEY),
    ]) {
      expect(remoteErrorOf(await call().catch((error: unknown) => error))).toMatchObject({ code: 'gateway/internal' })
    }
  })
})
