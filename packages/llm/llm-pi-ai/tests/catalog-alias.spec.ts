import { describe, expect, it } from 'vitest'
import { catalogModels, catalogProvider, catalogProviderIds, resolveRouteModels } from '../src/catalog.ts'
import { providerDefaultsOf } from '../src/provider-data.ts'

describe('the anthropic-oauth alias route', () => {
  it('is listed immediately after anthropic', () => {
    const ids = catalogProviderIds()
    expect(ids[ids.indexOf('anthropic') + 1]).toBe('anthropic-oauth')
  })

  it('is the anthropic provider re-identified with OAuth as its only auth', () => {
    const alias = catalogProvider('anthropic-oauth')!
    const base = catalogProvider('anthropic')!
    expect(alias.id).toBe('anthropic-oauth')
    expect(alias.name).toBe('anthropicOauth')
    expect(alias.auth.apiKey).toBeUndefined()
    expect(alias.auth.oauth).toBe(base.auth.oauth)
    expect(alias.getModels()).toEqual(base.getModels())
  })

  it('serves the base models and rewrites them to the alias route key', () => {
    expect([...catalogModels('anthropic-oauth').keys()]).toEqual([...catalogModels('anthropic').keys()])
    const { models } = resolveRouteModels({
      provider: 'anthropic-oauth', defaultContextWindow: 200_000, defaultMaxTokens: 8192, defaultInput: ['text'],
    })
    expect(models.length).toBeGreaterThan(0)
    expect(models.every(model => model.provider === 'anthropic-oauth')).toBe(true)
  })

  it('reports keyless OAuth native auth', () => {
    expect(providerDefaultsOf(catalogProvider('anthropic-oauth')!).nativeAuth).toEqual({ env: [], oauth: true })
  })
})
