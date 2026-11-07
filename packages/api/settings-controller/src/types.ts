/**
 * Browser-safe failure vocabulary of the configuration surfaces this package
 * serves. The redacted views themselves live with their seam in
 * `@deepseek-ai/dsh-settings/types`, whose Cordis event declarations already
 * register that file for the Client compilation face.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/types
 */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * Every seam refusal that is not a stale write: an unregistered or malformed
     * namespace, a read-only provider, schema validation, storage.
     */
    'settings/rejected': { readonly ns: string }
    /**
     * The stored revision moved after the caller read it. Its own outcome rather
     * than an invalid request: the caller must re-read and re-apply.
     */
    'settings/conflict': { readonly ns: string; readonly expected: number; readonly actual: number }
    /**
     * The provider refused a valid credential write, for example because the
     * stored document no longer parses. The details name only the reference,
     * never the value.
     */
    'credential/rejected': { readonly ref: string }
    /**
     * An authorization attempt failed or was refused. The details name only the
     * credential key, never anything the flow handled.
     */
    'authorization/failed': { readonly key: string }
  }
}

/** Confirmation that the settings document was handed to the native editor. */
export interface SettingsDocumentOpenValue {
  readonly opened: true
}

/** One authorization flow as a configuration page sees it; never carries a secret. */
export interface AuthorizationEntryView {
  /** The credential record the flow writes. */
  readonly key: string
  /** User-facing name of what is authorized. */
  readonly label: string
  /** The methods the flow offers, most preferred first. */
  readonly methods: readonly { readonly id: string; readonly label: string }[]
  /** Whether an attempt is running right now. */
  readonly inFlight: boolean
  /** Whether the record exists. */
  readonly signedIn: boolean
}

/** What an attempt reports while it runs, in order, ending with `settled`. */
export type AuthorizationEvent =
  | { readonly type: 'notice'; readonly message: string; readonly url?: string; readonly code?: string }
  | {
    readonly type: 'prompt'
    /** Identifies the question when it is answered. */
    readonly promptId: string
    readonly kind: 'text' | 'secret' | 'select'
    readonly message: string
    readonly placeholder?: string
    readonly options?: readonly { readonly id: string; readonly label: string }[]
  }
  | { readonly type: 'settled'; readonly status: 'authorized' | 'cancelled' }
