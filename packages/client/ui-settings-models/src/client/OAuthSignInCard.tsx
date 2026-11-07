/**
 * The sign-in control of a route that authenticates by OAuth: its status, the
 * link and code a flow shows the human, the questions it asks, and sign-out.
 * The card holds no grant and never sees one; every call goes through
 * {@link AuthorizationOperations}.
 *
 * @module dsh-client-ui-settings-models/client/OAuthSignInCard
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { AuthorizationEvent } from '@deepseek-ai/dsh-api-remotes/client'
import type { AuthorizationOperations } from './operations.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Props of {@link OAuthSignInCard}. */
export interface OAuthSignInCardProps {
  /** Provider route key; the flow's credential key ends with it. */
  route: string
  /** The sign-in calls the card makes. */
  operations: AuthorizationOperations
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Disable every control (read-only settings provider). */
  disabled?: boolean
}

type Prompt = Extract<AuthorizationEvent, { type: 'prompt' }>
type Notice = Extract<AuthorizationEvent, { type: 'notice' }>
interface Info { readonly key: string; readonly signedIn: boolean; readonly inFlight: boolean }
interface Message { readonly kind: 'info' | 'error'; readonly text: string }

/** Only web links are rendered as links; a flow cannot hand the page a script URL. */
function isWebUrl(url: string | undefined): url is string {
  return url !== undefined && /^https?:\/\//i.test(url)
}

/**
 * Render one route's OAuth sign-in control.
 * @param props - the route, its operations, copy and read-only state.
 * @returns the control, or nothing while no flow is known to serve the route.
 */
export function OAuthSignInCard({ route, operations, t, disabled = false }: OAuthSignInCardProps): ReactNode {
  const [info, setInfo] = useState<Info | undefined>()
  const [waiting, setWaiting] = useState(false)
  const [notice, setNotice] = useState<Notice | undefined>()
  const [prompt, setPrompt] = useState<Prompt | undefined>()
  const [draft, setDraft] = useState('')
  const [message, setMessage] = useState<Message | undefined>()
  const [copied, setCopied] = useState(false)
  const attempt = useRef<AbortController | undefined>(undefined)

  const refresh = async (): Promise<Info | undefined> => {
    const next = await operations.status(route)
    setInfo(next)
    return next
  }

  useEffect(() => {
    void refresh()
    return () => { attempt.current?.abort() }
    // The route and the bound operations are fixed for the life of an editor.
  }, [route, operations])

  if (info === undefined) return null

  const onEvent = (event: AuthorizationEvent): void => {
    if (event.type === 'notice') {
      setNotice(event)
      setCopied(false)
    } else if (event.type === 'prompt') {
      setPrompt(event)
      setDraft('')
    }
  }

  const inFlightMessage: Message = { kind: 'info', text: t('oauthInFlight') }

  const start = async (): Promise<void> => {
    if (info.inFlight) {
      // What the card read at mount may be out of date: ask again before refusing.
      const fresh = await refresh()
      if (fresh?.inFlight !== false) {
        setMessage(inFlightMessage)
        return
      }
    }
    const controller = new AbortController()
    attempt.current = controller
    setMessage(undefined)
    setNotice(undefined)
    setPrompt(undefined)
    setWaiting(true)
    void operations.signIn(info.key, onEvent, controller.signal).then(async (outcome) => {
      setWaiting(false)
      setNotice(undefined)
      setPrompt(undefined)
      const fresh = await refresh()
      if ('failed' in outcome) {
        // A refusal because another attempt owns the flow is "in progress", not a failure.
        setMessage(fresh?.inFlight === true
          ? inFlightMessage
          : { kind: 'error', text: t('oauthFailed').replace('{message}', () => outcome.failed) })
      }
    })
  }

  const answer = async (asked: Prompt): Promise<void> => {
    const refusal = await operations.answer(info.key, asked.promptId, draft.trim())
    if (refusal === undefined) {
      setPrompt(undefined)
    } else {
      setMessage({ kind: 'error', text: t('oauthFailed').replace('{message}', () => refusal) })
    }
  }

  const signOut = async (): Promise<void> => {
    const refusal = await operations.signOut(info.key)
    setMessage(refusal === undefined ? undefined : { kind: 'error', text: t('oauthFailed').replace('{message}', () => refusal) })
    await refresh()
  }

  const copy = async (url: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch { /* A refused copy leaves the link visible to open instead. */ }
  }

  const url = isWebUrl(notice?.url) ? notice.url : undefined
  const code = notice?.code
  const failed = message?.kind === 'error'
  return (
    <div className={styles['field']}>
      <span className={styles['fieldLabel']}>{t('oauthLabel')}</span>
      {waiting
        ? (
          <>
            <p className={styles['advancedHint']}>{t('oauthWaiting')}</p>
            {notice === undefined ? null : <p className={styles['notice']}>{notice.message}</p>}
            {code === undefined ? null : <p className={styles['advancedHint']}>{t('oauthCode').replace('{code}', () => code)}</p>}
            {url === undefined
              ? null
              : (
                <div className={styles['rowActions']}>
                  <a className={styles['linkButton']} href={url} target="_blank" rel="noopener noreferrer">{t('oauthOpenLink')}</a>
                  <button type="button" className={styles['secondaryButton']} onClick={() => { void copy(url) }}>
                    {copied ? t('oauthCopied') : t('oauthCopyLink')}
                  </button>
                </div>
              )}
            {prompt === undefined
              ? null
              : (
                <div className={styles['field']}>
                  <label className={styles['fieldLabel']} htmlFor={`${route}-oauth-answer`}>{prompt.message}</label>
                  {prompt.kind === 'select'
                    ? (
                      <select
                        id={`${route}-oauth-answer`}
                        className={`${styles['input']} ${styles['selectInput']}`}
                        value={draft}
                        onChange={(event) => { setDraft(event.target.value) }}
                      >
                        <option value="" />
                        {(prompt.options ?? []).map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
                      </select>
                    )
                    : (
                      <input
                        id={`${route}-oauth-answer`}
                        className={styles['input']}
                        type={prompt.kind === 'secret' ? 'password' : 'text'}
                        autoComplete="off"
                        placeholder={prompt.placeholder}
                        value={draft}
                        onChange={(event) => { setDraft(event.target.value) }}
                      />
                    )}
                  <button type="button" className={styles['primaryButton']} disabled={draft.trim().length === 0} onClick={() => { void answer(prompt) }}>
                    {t('oauthSubmit')}
                  </button>
                </div>
              )}
            <div className={styles['rowActions']}>
              <button type="button" className={styles['secondaryButton']} onClick={() => { attempt.current?.abort() }}>
                {t('cancel')}
              </button>
            </div>
          </>
        )
        : (
          <div className={styles['rowActions']}>
            <span>{info.signedIn ? t('oauthSignedIn') : t('oauthSignedOut')}</span>
            {info.signedIn
              ? (
                <button type="button" className={styles['secondaryButton']} disabled={disabled} onClick={() => { void signOut() }}>
                  {t('oauthSignOut')}
                </button>
              )
              : (
                <button type="button" className={styles['primaryButton']} disabled={disabled} onClick={() => { void start() }}>
                  {failed ? t('oauthRetry') : t('oauthSignIn')}
                </button>
              )}
          </div>
        )}
      {message === undefined ? null : <p className={styles[failed ? 'error' : 'notice']}>{message.text}</p>}
    </div>
  )
}
