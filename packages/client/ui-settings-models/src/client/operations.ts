/**
 * The Host reads and writes the Models cards perform, as callbacks built in the
 * plugin body. Cards receive these instead of a context: the outcomes name what
 * a card renders — a stored view, a stale revision, a refusal message — so the
 * failure codes and Remote namespaces stay in the apply world.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {
  AuthorizationEvent, LlmDiscoveredModel, LlmModelDiscoveryRequest,
  SettingsNamespaceView, SettingsPathOpView,
} from '@deepseek-ai/dsh-api-remotes/client'

/** What one namespace write answered. */
export type SettingsWriteOutcome =
  /** Committed; the view carries the stored user subtree and the new revision. */
  | { readonly kind: 'written'; readonly view: SettingsNamespaceView }
  /**
   * The stored revision moved after the card read it, so the draft is stale.
   * The message stays for callers that report the Host diagnostic as it is.
   */
  | { readonly kind: 'conflict'; readonly message: string }
  /** Any other refusal, with the Host's own diagnostic. */
  | { readonly kind: 'refused'; readonly message: string }

/** What one endpoint interrogation answered. */
export type ModelDiscoveryOutcome =
  /** The candidates the provider disclosed, in its own order. */
  | { readonly kind: 'found'; readonly models: readonly LlmDiscoveredModel[] }
  /** The interrogation was refused, with the Host's own diagnostic. */
  | { readonly kind: 'refused'; readonly message: string }

/** How a sign-in attempt ended: settled, or failed with the Host's message. */
export type SignInOutcome =
  | { readonly status: 'authorized' | 'cancelled' }
  | { readonly failed: string }

/** The sign-in calls a route's OAuth card makes; no call returns a grant. */
export interface AuthorizationOperations {
  /**
   * Whether the route's sign-in flow has a stored record, and whether an attempt is running.
   * @param route - provider route key, which the flow's credential key ends with.
   * @returns the flow's key and status, or undefined when no flow serves the route or the list is refused.
   */
  status(route: string): Promise<{ key: string; signedIn: boolean; inFlight: boolean } | undefined>
  /**
   * Run one attempt, reporting each notice and question as it arrives.
   * @param key - the flow's credential key from {@link status}.
   * @param on - receives every event before the final settlement.
   * @param signal - withdrawing it cancels the attempt.
   * @returns how the attempt ended.
   */
  signIn(key: string, on: (event: AuthorizationEvent) => void, signal: AbortSignal): Promise<SignInOutcome>
  /** Answer a waiting question; resolves the refusal message, or undefined once delivered. */
  answer(key: string, promptId: string, value: string): Promise<string | undefined>
  /** Withdraw the running attempt; resolves the refusal message, or undefined. */
  cancel(key: string): Promise<string | undefined>
  /** Delete the stored record; resolves the refusal message, or undefined. */
  signOut(key: string): Promise<string | undefined>
}

/** The Host operations the Models page and its cards invoke. */
export interface ModelsOperations {
  /**
   * Store one credential literal under its reference.
   * @param ref - credential reference name.
   * @param value - the literal to store.
   * @returns the refusal message, or undefined once stored.
   */
  storeCredential(ref: string, value: string): Promise<string | undefined>
  /**
   * Remove one credential reference (idempotent).
   * @param ref - credential reference name.
   * @returns the refusal message, or undefined once removed.
   */
  removeCredential(ref: string): Promise<string | undefined>
  /**
   * Apply path operations to one settings namespace.
   * @param ns - settings namespace identity.
   * @param ops - ordered path operations against the stored section, as the
   * wire takes them (the Remote signature owns the array).
   * @param expectedRevision - revision the draft was opened at, or undefined to write unfenced.
   * @returns the write outcome the card renders from.
   */
  writeSettings(
    ns: string,
    ops: SettingsPathOpView[],
    expectedRevision: number | undefined,
  ): Promise<SettingsWriteOutcome>
  /**
   * Ask a provider endpoint what models it serves.
   * @param settingsNs - namespace whose adapter family answers.
   * @param request - endpoint facts as the form currently shows them.
   * @returns the candidates, or the refusal.
   */
  discoverModels(settingsNs: string, request: LlmModelDiscoveryRequest): Promise<ModelDiscoveryOutcome>
  /** Sign-in calls for routes that authenticate by OAuth; absent where the host mounts none. */
  authorization?: AuthorizationOperations
}

/**
 * Bind the page's Host operations to the plugin's own Remote namespaces.
 * @param ctx - the page plugin's context, which declares `remote.credentials`,
 * `remote.llm`, and `remote.settings` in its own `inject`.
 * @returns the callbacks the section and its cards are injected with.
 */
export function createModelsOperations(ctx: ClientContext): ModelsOperations {
  return {
    storeCredential: async (ref, value) => {
      const response = await ctx.remote.credentials.set(ref, value)
      return response.ok ? undefined : response.error.message
    },
    removeCredential: async (ref) => {
      const response = await ctx.remote.credentials.unset(ref)
      return response.ok ? undefined : response.error.message
    },
    writeSettings: async (ns, ops, expectedRevision) => {
      const response = await ctx.remote.settings.mutate(ns, ops, expectedRevision)
      if (response.ok) return { kind: 'written', view: response.value }
      const { code, message } = response.error
      return code === 'settings/conflict' ? { kind: 'conflict', message } : { kind: 'refused', message }
    },
    discoverModels: async (settingsNs, request) => {
      const response = await ctx.remote.llm.discoverModels(settingsNs, request)
      return response.ok
        ? { kind: 'found', models: response.value }
        : { kind: 'refused', message: response.error.message }
    },
    authorization: createAuthorizationOperations(ctx),
  }
}

/** Bind the sign-in calls to the plugin's `remote.authorization` namespace. */
function createAuthorizationOperations(ctx: ClientContext): AuthorizationOperations {
  const refusal = async (call: Promise<{ ok: true } | { ok: false; error: { message: string } }>): Promise<string | undefined> => {
    const response = await call
    return response.ok ? undefined : response.error.message
  }
  return {
    status: async (route) => {
      const response = await ctx.remote.authorization.list()
      if (!response.ok) return undefined
      const flow = response.value.find(entry => entry.key.endsWith(`/${route}`))
      return flow === undefined ? undefined : { key: flow.key, signedIn: flow.signedIn, inFlight: flow.inFlight }
    },
    signIn: async (key, on, signal) => {
      const stream = ctx.remote.authorization.begin(key, undefined, signal)
      try {
        for await (const event of stream) {
          on(event)
          if (event.type === 'settled') return { status: event.status }
        }
        return { status: 'cancelled' }
      } catch (error: unknown) {
        // Withdrawing the attempt ends the stream with the abort reason; that is a cancel, not a failure.
        if (signal.aborted) return { status: 'cancelled' }
        return { failed: error instanceof Error ? error.message : String(error) }
      } finally {
        stream.dispose()
      }
    },
    answer: (key, promptId, value) => refusal(ctx.remote.authorization.answer(key, promptId, value)),
    cancel: key => refusal(ctx.remote.authorization.cancel(key)),
    signOut: key => refusal(ctx.remote.authorization.signOut(key)),
  }
}
