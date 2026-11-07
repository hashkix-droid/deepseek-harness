/**
 * Host owner of the `authorization` Remote namespace: the registered
 * credential-obtaining flows of `ctx.authorization` as a browser configuration
 * page lists, runs, answers and signs out of them.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/src/authorization.ts
 */

import { Context } from '@deepseek-ai/cordis'
import type { AuthorizationPrompt } from '@deepseek-ai/dsh-authorization'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import type { AuthorizationEntryView, AuthorizationEvent } from './types.ts'

const MAX_ANSWER_LENGTH = 16_384
const keySchema = z.string().min(1).max(256)
const answerSchema = z.object({ key: keySchema, promptId: z.string().min(1).max(64), value: z.string().max(MAX_ANSWER_LENGTH) })

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `authorization` Remote namespace. */
    authorizationController: AuthorizationController
  }
}

/** The parking slot of one question: credential keys never contain a newline. */
function slotOf(key: string, promptId: string): string {
  return `${key}\n${promptId}`
}

/** A question the human has not answered yet. */
interface Pending {
  readonly resolve: (value: string) => void
  readonly reject: (reason: unknown) => void
}

/**
 * Host service backing the generated `ctx.remote.authorization` namespace. It
 * carries the wire obligations the authorization seam does not: key
 * validation against the registered flows, the field-by-field view projection,
 * the refusal mapping, and the prompt round trip. Secret values cross in one
 * direction only — an answer goes in, and no method returns a stored grant.
 */
export class AuthorizationController extends TypertRemoteService {
  /** Parked questions by {@link slot}: a flow may hold several at once (a typed code racing a browser callback). */
  private readonly pending = new Map<string, Pending>()
  private nextPrompt = 0

  /** @param ctx - Host context where the authorization and credential services may be mounted. */
  constructor(ctx: Context) {
    super(ctx, 'authorizationController', { namespace: 'authorization' })
  }

  /**
   * List every registered flow with whether its record exists.
   * @returns one view per flow.
   * @throws RemoteError when no authorization service is mounted.
   */
  @Remote
  async list(): Promise<AuthorizationEntryView[]> {
    const authorization = this.service()
    return Promise.all(authorization.list().map(async entry => ({
      key: entry.key,
      label: entry.label,
      methods: entry.methods.map(method => ({ id: method.id, label: method.label })),
      inFlight: entry.inFlight,
      signedIn: (await this.credentials().describeRecord(entry.key)).configured,
    })))
  }

  /**
   * Run one attempt, reporting what it says and asks until it settles.
   * Aborting the stream withdraws the attempt.
   * @param key - credential key of a registered flow.
   * @param method - method id; the flow's first when absent.
   * @param signal - caller withdrawal.
   * @returns notices and prompts in order, then a final `settled`.
   * @throws RemoteError `authorization/failed` when the attempt fails or is refused.
   */
  @Remote({ mode: 'stream' })
  async *begin(key: string, method: string | undefined, signal: AbortSignal): AsyncIterable<AuthorizationEvent> {
    const flowKey = this.flowKey(key)
    const queue: AuthorizationEvent[] = []
    let wake: (() => void) | undefined
    const push = (event: AuthorizationEvent): void => {
      queue.push(event)
      wake?.()
    }
    const done = { value: false }
    const parked = new Set<string>()
    const attempt = this.service().begin({
      key: flowKey,
      ...method === undefined ? {} : { method },
      signal,
      interaction: {
        notify: (notice) => {
          push({
            type: 'notice',
            message: notice.message,
            ...notice.url === undefined ? {} : { url: notice.url },
            ...notice.code === undefined ? {} : { code: notice.code },
          })
        },
        prompt: prompt => this.ask(key, prompt, push, parked),
      },
    }).then(
      outcome => ({ outcome }),
      (error: unknown) => ({ error }),
    ).finally(() => {
      done.value = true
      wake?.()
    })
    try {
      while (!done.value || queue.length > 0) {
        const next = queue.shift()
        if (next !== undefined) {
          yield next
          continue
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
      const settled = await attempt
      if ('error' in settled) throw this.failure(key, settled.error)
      yield { type: 'settled', status: settled.outcome.status }
    } finally {
      this.service().cancel(flowKey)
      this.dropPending(parked)
    }
  }

  /**
   * Answer the question an attempt is waiting on.
   * @param key - credential key of the running flow.
   * @param promptId - the id its `prompt` event carried.
   * @param value - the human's answer.
   * @throws RemoteError `gateway/bad-request` when the key or question is unknown.
   */
  @Remote
  // eslint-disable-next-line @typescript-eslint/require-await -- refusals must reject, never throw synchronously
  async answer(key: string, promptId: string, value: string): Promise<void> {
    const request = this.parse('authorization.answer', answerSchema, { key, promptId, value })
    this.flowKey(request.key)
    const slot = slotOf(request.key, request.promptId)
    const pending = this.pending.get(slot)
    if (pending === undefined) {
      throw new RemoteError('gateway/bad-request', 'no such question is waiting for an answer', {})
    }
    this.pending.delete(slot)
    pending.resolve(request.value)
  }

  /**
   * Withdraw a running attempt (idempotent).
   * @param key - credential key of a registered flow.
   * @throws RemoteError `gateway/bad-request` when the key names no flow.
   */
  @Remote
  // eslint-disable-next-line @typescript-eslint/require-await -- refusals must reject, never throw synchronously
  async cancel(key: string): Promise<void> {
    this.service().cancel(this.flowKey(key))
  }

  /**
   * Delete the stored record so the flow is signed out (idempotent).
   * @param key - credential key of a registered flow.
   * @throws RemoteError `gateway/bad-request` when the key names no flow, or `authorization/failed` when the store refuses.
   */
  @Remote
  async signOut(key: string): Promise<void> {
    const flowKey = this.flowKey(key)
    try {
      await this.credentials().deleteRecord(flowKey)
    } catch (error: unknown) {
      throw this.failure(key, error)
    }
  }

  /** Put one question to the human and park its answer until {@link answer} or withdrawal. */
  private ask(
    key: string,
    prompt: AuthorizationPrompt,
    push: (event: AuthorizationEvent) => void,
    parked: Set<string>,
  ): Promise<string> {
    const promptId = `p${String(++this.nextPrompt)}`
    return new Promise<string>((resolve, reject) => {
      const slot = slotOf(key, promptId)
      parked.add(slot)
      this.pending.set(slot, { resolve, reject })
      prompt.signal?.addEventListener('abort', () => {
        // Rejecting a question that was already answered is a no-op.
        this.pending.delete(slot)
        reject(new Error('the question was withdrawn', { cause: prompt.signal?.reason }))
      }, { once: true })
      push({
        type: 'prompt',
        promptId,
        kind: prompt.kind,
        message: prompt.message,
        ...prompt.kind === 'select'
          ? { options: prompt.options.map(option => ({ id: option.id, label: option.label })) }
          : prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder },
      })
    })
  }

  /** Reject the questions an attempt left parked when it is over. */
  private dropPending(slots: ReadonlySet<string>): void {
    for (const slot of slots) {
      const pending = this.pending.get(slot)
      if (pending === undefined) continue
      this.pending.delete(slot)
      pending.reject(new Error('the authorization attempt ended'))
    }
  }

  /** Resolve the registered flow a caller names, or refuse the request. */
  private flowKey(key: string): CredentialKey {
    const parsed = this.parse('authorization', keySchema, key)
    const entry = this.service().list().find(candidate => candidate.key === parsed)
    if (entry === undefined) {
      throw new RemoteError('gateway/bad-request', 'no authorization flow is registered for that key', {})
    }
    return entry.key
  }

  /** Map any failure to the seam's own message, naming only the key. */
  private failure(key: string, error: unknown): RemoteError {
    return new RemoteError(
      'authorization/failed',
      error instanceof Error ? error.message : String(error),
      { key },
      { cause: error },
    )
  }

  private parse<T>(method: string, schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value)
    if (!parsed.success) {
      throw new RemoteError('gateway/bad-request', `invalid payload for ${method}`, { issues: parsed.error.issues })
    }
    return parsed.data
  }

  /** Resolve the optional credential provider or report how to supply it. */
  private credentials(): NonNullable<Context['credentials']> {
    const credentials = this.ctx.get('credentials')
    /* v8 ignore next 6 -- `authorization` injects `credentials`, so no composition mounts one without the other;
       the guard keeps a torn-down credential provider from becoming a bare TypeError on the wire. */
    if (credentials === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'credentials service is absent: this deployment does not mount a credential provider (e.g. @deepseek-ai/dsh-credentials-local) in its composition',
        {},
      )
    }
    return credentials
  }

  /** Resolve the optional authorization service or report how to supply it. */
  private service(): NonNullable<Context['authorization']> {
    const authorization = this.ctx.get('authorization')
    if (authorization === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'authorization service is absent: this deployment does not mount @deepseek-ai/dsh-authorization in its composition',
        {},
      )
    }
    return authorization
  }
}

export default AuthorizationController
