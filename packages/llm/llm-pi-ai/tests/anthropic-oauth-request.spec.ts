import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { recordKeyFor } from '../src/auth.ts'
import { assemble } from './assemble.ts'
import { anthropicTextEvents, closeMockServers, mockServer } from './mock-server.ts'

afterEach(closeMockServers)

const MODEL = getBuiltinModels('anthropic')[0]?.id ?? 'claude'
const ACCESS = 'sk-ant-oat01-stored-access-token'

async function harness(baseURL: string, seed: boolean): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials)
  if (seed) {
    await ctx.credentials.modifyRecord(recordKeyFor('anthropic-oauth'), () => Promise.resolve({
      kind: 'grant',
      payload: { type: 'oauth', access: ACCESS, refresh: 'refresh-token', expires: Date.now() + 3_600_000 },
    }))
  }
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, { providers: { 'anthropic-oauth': { baseURL } } })
  return ctx
}

const ask = (ctx: Context) => assemble(ctx, {
  provider: 'anthropic-oauth',
  model: MODEL,
  messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'test' } })],
})

describe('a request on the anthropic-oauth route', () => {
  it('authenticates with the stored OAuth grant, not an API key', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const ctx = await harness(server.url, true)

    const result = await ask(ctx)

    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.headers[0]?.authorization).toBe(`Bearer ${ACCESS}`)
    expect(server.headers[0]?.['x-api-key']).toBeUndefined()
  })

  it('fails with the not-configured diagnostic and sends nothing while the route is signed out', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const ctx = await harness(server.url, false)

    const result = await ask(ctx)
    // The adapter's existing diagnostic for an unauthenticated route; the card's signed-out state is the recovery path.
    expect(result.finish).toMatchObject({ kind: 'error', failure: { message: 'Provider is not configured: anthropic-oauth' } })
    expect(server.paths).toEqual([])
  })
})
