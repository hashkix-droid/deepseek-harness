/** Installed provider defaults for configuration surfaces. */

import type { Provider } from '@earendil-works/pi-ai'
import type { LlmConfigurableProvider } from '@deepseek-ai/dsh-llm'
import { aliasBaseOf } from './catalog.ts'
import { PROVIDER_DATA } from './provider-data.generated.ts'

/**
 * Return generated display metadata without executing authentication.
 * @param provider - Installed catalog provider, possibly from a newer consumer dependency.
 * @returns Known metadata, or only a fixed public endpoint for an unrecorded provider.
 */
export function providerDefaultsOf(provider: Provider): Pick<LlmConfigurableProvider, 'nativeAuth' | 'defaultBaseURL' | 'baseURLEnv'> {
  const data = PROVIDER_DATA[aliasBaseOf(provider.id)]
  // A consumer can install a newer pi-ai within the dependency range. An
  // unrecorded provider remains configurable without guessed auth metadata.
  if (data === undefined) return provider.baseUrl && !provider.baseUrl.includes('{') ? { defaultBaseURL: provider.baseUrl } : {}
  const { env, ...endpoint } = data
  // An OAuth-only alias route reads no environment variable: its base's
  // credential variables authenticate the base route, not this one.
  const keyless = aliasBaseOf(provider.id) !== provider.id
  return { ...endpoint, nativeAuth: { env: keyless ? [] : env, oauth: provider.auth.oauth !== undefined } }
}
