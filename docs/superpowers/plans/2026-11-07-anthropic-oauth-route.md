# anthropicOauth Route Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `anthropicOauth` entry directly below `anthropic` in Settings → Models → Add provider, with a working in-page OAuth sign-in and requests that use the stored OAuth grant.

**Architecture:** An alias catalog provider `anthropic-oauth` (the installed `anthropic` provider re-identified, OAuth auth only) is inserted into the pi-ai catalog index right after `anthropic`, so the directory, login registration, model resolution and provider building pick it up unchanged. A new `authorization` Remote namespace (mounted by `SettingsController`, beside `credentials`) exposes the existing `ctx.authorization` service; a sign-in card in `ui-settings-models` drives it.

**Tech Stack:** TypeScript, Cordis plugins, `@deepseek-ai/dsh-typert-protocol` Remotes (`@Remote`, `mode: 'stream'`), React client, pi-ai (`@earendil-works/pi-ai`), vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-11-07-anthropic-oauth-route-design.md`. One refinement to the spec: the controller lives in `packages/api/settings-controller` (mounted like `CredentialsController`, `src/index.ts:88`), not a new package, so no new workspace, gateway entry or bundle wiring is needed.

## Global Constraints

- Route key `anthropic-oauth` (lowercase, hyphenated: must satisfy `isCredentialKeySegment`); display name exactly `anthropicOauth`.
- Directory position: immediately after `anthropic`.
- Credential record `llm-pi-ai/anthropic-oauth` is separate from `llm-pi-ai/anthropic`.
- No Remote method ever returns a token or grant.
- Repo gates: per-file 100% coverage on `packages/*/*/src`, `pnpm run typecheck`, `pnpm run lint`, `pnpm run duplication`. Follow `AGENTS.md` and `docs/architecture.md`; docs per `docs/AGENTS.md`. Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Windows: keep clones/paths short (repo already at `C:\deepseek-harness`).

## Review Focus

- Both `anthropic` and `anthropic-oauth` routes configured at once: each uses its own record (Task 1, Task 2 tests).
- Signing in twice / second `begin` while one is running: `ALREADY_IN_FLIGHT` shown as a message, not a crash (Task 3, Task 5).
- Closing the editor or dropping the stream mid sign-in cancels the attempt (Task 3, Task 5).
- Prompt answered for an unknown/expired `promptId` is refused, not hung (Task 3).
- Signed-out route used for a request: existing missing-credential error, card shows signed-out (Task 5).

---

### Task 1: Alias catalog provider `anthropic-oauth`

**Files:**
- Modify: `packages/llm/llm-pi-ai/src/catalog.ts` (`catalogProviders`, `catalogModels`, ~lines 185-215)
- Test: `packages/llm/llm-pi-ai/tests/catalog-provider-ids.spec.ts`, `packages/llm/llm-pi-ai/tests/native-auth.spec.ts`

**Interfaces:**
- Produces: `catalogProviderIds()` contains `'anthropic-oauth'` immediately after `'anthropic'`; `catalogProvider('anthropic-oauth')` returns a provider with `id: 'anthropic-oauth'`, `name: 'anthropicOauth'`, `auth: { oauth: <anthropic's oauth> }` and no `apiKey`, delegating `getModels/stream/streamSimple` to the base; `catalogModels('anthropic-oauth')` equals `catalogModels('anthropic')`.

- [ ] **Step 1: Write failing tests**: in `catalog-provider-ids.spec.ts`, `it('lists anthropic-oauth immediately after anthropic')` asserting `ids[ids.indexOf('anthropic') + 1] === 'anthropic-oauth'`; in `native-auth.spec.ts`, `it('reports anthropic-oauth as keyless OAuth')` asserting `providerDefaultsOf(catalogProvider('anthropic-oauth')!).nativeAuth` equals `{ env: [], oauth: true }`, and `catalogProvider('anthropic-oauth')!.auth.apiKey` is `undefined`.
- [ ] **Step 2: Run** `pnpm vitest run packages/llm/llm-pi-ai/tests/catalog-provider-ids.spec.ts packages/llm/llm-pi-ai/tests/native-auth.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** a `ROUTE_ALIASES` constant `{ 'anthropic-oauth': { base: 'anthropic', name: 'anthropicOauth' } }` and extend `catalogProviders()` to insert each alias after its base as `{ ...base, id, name, auth: { oauth: base.auth.oauth } }` (omit the key if the base has no oauth, and skip the alias then). `catalogModels(alias)` reads the base's models. Do not copy base state; the alias keeps delegating via the spread's functions bound to the base (`stream: (...a) => base.stream(...a)`).
- [ ] **Step 4: Verification gate (spec risk 1)**: add `it('resolves alias models with provider rewritten to the route key')` in `catalog.spec.ts` calling `resolveRouteModels` for `anthropic-oauth` and asserting every model's `provider === 'anthropic-oauth'`. If pi-ai's catalog models keep `provider: 'anthropic'` and dispatch breaks, fix in `resolveRouteModels`' route-model construction. Run the three spec files; expected PASS.
- [ ] **Step 5: Commit** `feat(llm-pi-ai): add anthropic-oauth alias catalog route`.

### Task 2: Directory entry and sign-in flow for the alias

**Files:**
- Test: `packages/llm/llm-pi-ai/tests/login.spec.ts`, `packages/llm/llm-pi-ai/tests/dynamic-config.spec.ts`
- Modify (only if the tests fail): `packages/llm/llm-pi-ai/src/login.ts`, `src/index.ts`

**Interfaces:**
- Consumes: Task 1's alias in `catalogProviderIds()`.
- Produces: `ctx.authorization.list()` includes key `recordKeyFor('anthropic-oauth')` with `methods` exactly `[{ id: 'oauth', label: <pi-ai oauth loginLabel/name> }]`; `ctx.llm.listConfigurableProviders()` lists `anthropic-oauth` with `displayName: 'anthropicOauth'` right after `anthropic`, `declared: false`, `nativeAuth: { env: [], oauth: true }`.

- [ ] **Step 1: Write failing tests**: in `login.spec.ts`, `it('registers an oauth-only flow for anthropic-oauth')` (assert methods ids `['oauth']` and that running it with the existing test double commits a record under `llm-pi-ai/anthropic-oauth` and leaves `llm-pi-ai/anthropic` absent); `it('keeps anthropic-oauth and anthropic records independent')` signing into both. In `dynamic-config.spec.ts`, `it('offers anthropicOauth below anthropic in the directory')` as above. Note: `displayName` for catalog entries comes from `declare(provider, provider)` in `directoryEntries`; the test pins `'anthropicOauth'`, so change `directoryEntries` to use `catalogProvider(id)?.name` only for aliases.
- [ ] **Step 2: Run** the two spec files. Expected: FAIL (display name; possibly flow label).
- [ ] **Step 3: Implement** the minimal changes the failures demand: `directoryEntries` passes the alias's `name`; confirm `loginMethods` yields only `oauth` (no api-key since `auth.apiKey` is absent). Check the existing `UNSERVED_OAUTH` set does not include it.
- [ ] **Step 4: Run** `pnpm vitest run packages/llm/llm-pi-ai` and `pnpm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(llm-pi-ai): offer anthropicOauth route and flow`.

### Task 3: `authorization` Remote controller

**Files:**
- Create: `packages/api/settings-controller/src/authorization.ts` (class `AuthorizationController`, namespace `authorization`, service key `authorizationController`)
- Modify: `packages/api/settings-controller/src/index.ts` (mount `ctx.plugin(AuthorizationController)` beside line 88; re-export; add the Context augmentation in the new file as `credentials.ts` does), `packages/api/settings-controller/src/types.ts` (wire types)
- Test: `packages/api/settings-controller/tests/authorization-controller.host.spec.ts`, update `settings-controller.host.spec.ts` (`ctx.get('authorizationController')` defined)

**Interfaces:**
- Produces (types in `types.ts`): `AuthorizationEntryView = { key: string; label: string; methods: { id: string; label: string }[]; inFlight: boolean; signedIn: boolean }`; `AuthorizationEvent = { type: 'notice'; message: string; url?: string; code?: string } | { type: 'prompt'; promptId: string; kind: 'text' | 'secret' | 'select'; message: string; placeholder?: string; options?: { id: string; label: string }[] } | { type: 'settled'; status: 'authorized' | 'cancelled' }`.
- Methods: `list(): Promise<AuthorizationEntryView[]>` (`@Remote`); `begin(key: string, method: string | undefined, signal: AbortSignal): AsyncIterable<AuthorizationEvent>` (`@Remote({ mode: 'stream' })`, abort cancels the attempt); `answer(key: string, promptId: string, value: string): Promise<void>`; `cancel(key: string): Promise<void>`; `signOut(key: string): Promise<void>` (delete the record, idempotent). All validate `key` against `ctx.authorization.list()` keys and refuse unknown with `RemoteError('gateway/bad-request', …)`; failures map to `RemoteError('authorization/failed', message)`; absent service gives `gateway/internal` with an actionable message like `CredentialsController.provider()`.

- [ ] **Step 1: Write failing tests** (mirror `credentials-controller.host.spec.ts`): `remoteMethods` lists exactly `list, begin(stream), answer, cancel, signOut`; `list` reports `signedIn` false then true after a fake flow commits; streaming `begin` yields a `notice` then a `prompt`, `answer` resolves it, stream ends with `settled: authorized`; aborting the signal ends with `cancelled` and `list()` shows `inFlight: false`; second concurrent `begin` throws code `authorization/failed` with `ALREADY_IN_FLIGHT` text; `answer` with a wrong `promptId` is `gateway/bad-request`; unknown key refused; no result contains the stored secret value (seed a record with a sentinel token and assert `JSON.stringify` of every result lacks it); `signOut` twice is fine.
- [ ] **Step 2: Run** `pnpm vitest run packages/api/settings-controller`. Expected: FAIL.
- [ ] **Step 3: Implement** `AuthorizationController extends TypertRemoteService` with `static inject = ['authorization']`-style optionality matching `CredentialsController` (service may be absent in headless compositions). `begin` builds an async queue fed by the interaction's `notify`/`prompt` (a `prompt` pushes a `prompt` event with a fresh `promptId` and parks a resolver in a per-key map) and by the final settlement; remove parked resolvers on settle/abort. `signedIn` uses `ctx.credentials.readRecord(key)` presence; `signOut` uses the same record-delete path `auth.ts` uses (`deleteRecord`).
- [ ] **Step 4: Run** the package tests, then `pnpm run build:artifacts` for `@deepseek-ai/dsh-api-settings-controller` so generated `typert.*` files expose `ctx.remote.authorization`; and `pnpm run test:coverage -- packages/api/settings-controller`. Expected: PASS, 100% on the new file.
- [ ] **Step 5: Docs/catalog**: update `packages/api/settings-controller/README.md` (+ `.zh.md`/`.i18n.yaml` per `docs/AGENTS.md`), and regenerate/add the `authorizationController` entries where `credentialsController` appears (`scripts/gen-cordis-catalog.ts:92`, `scripts/gen-doc-graphs.ts:379`, `packages/extensions/tool-cordis/src/api-catalog.ts:893`) using the repo's generators.
- [ ] **Step 6: Commit** `feat(api): expose authorization flows over the authorization Remote`.

### Task 4: Client operations for authorization

**Files:**
- Modify: `packages/client/ui-settings-models/src/client/operations.ts`, `packages/client/ui-settings-models/src/client/store.ts` if it holds a fake operations factory
- Test: `packages/client/ui-settings-models/tests/store.client.spec.ts` (or a new `authorization-operations.client.spec.ts`)

**Interfaces:**
- Consumes: Task 3's `ctx.remote.authorization`.
- Produces on `ModelsOperations`: `authorizationStatus(key: string): Promise<{ signedIn: boolean; inFlight: boolean } | undefined>`; `signIn(key: string, on: (event: AuthorizationEvent) => void, signal: AbortSignal): Promise<'authorized' | 'cancelled' | { failed: string }>`; `answerPrompt(key: string, promptId: string, value: string): Promise<string | undefined>`; `signOut(key: string): Promise<string | undefined>`. Credential key string = the one `list()` returns for route `anthropic-oauth` (`authorizationKeyOf(route)` helper looks it up by matching the entry whose key ends in `/anthropic-oauth`).

- [ ] **Step 1: Write failing tests** with a stub `ctx.remote.authorization`: status maps `list()`; `signIn` forwards notice/prompt events to `on` and resolves with the settled status; a `RemoteError` becomes `{ failed: message }`; `signOut` returns the refusal message or `undefined`.
- [ ] **Step 2: Run** `pnpm vitest run --config vitest.web.config.ts packages/client/ui-settings-models` (use the config the package's other `*.client.spec` tests run under). Expected: FAIL.
- [ ] **Step 3: Implement** the four functions in `createModelsOperations`, consuming the stream the way `ui-settings-account/src/client/index.ts:123` consumes `account.watch`.
- [ ] **Step 4: Run** the package tests + typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui-settings-models): authorization operations`.

### Task 5: OAuth sign-in card and editor integration

**Files:**
- Create: `packages/client/ui-settings-models/src/client/OAuthSignInCard.tsx` (+ small CSS in `ModelsSection.module.css`)
- Modify: `packages/client/ui-settings-models/src/client/ProviderEditor.tsx` (render the card in the keyless-OAuth branch, currently `keylessNativeAuth ? null : …` around line 401), `packages/client/ui-settings-models/src/client/locales.ts` (+ zh locale files alongside)
- Test: `packages/client/ui-settings-models/tests/oauth-sign-in-card.client.spec.tsx`, extend `components.client.spec.tsx`

**Interfaces:**
- Consumes: Task 4 operations.
- Produces: `OAuthSignInCard(props: { authKey: string; operations: ModelsOperations; t: (key: ModelsKey) => string; disabled?: boolean })` with states `signed-out | waiting | signed-in | failed`. New locale keys: `oauthSignIn`, `oauthSignOut`, `oauthRetry`, `oauthSignedIn`, `oauthSignedOut`, `oauthOpenLink`, `oauthCopyLink`, `oauthCodePrompt`, `oauthSubmitCode`, `oauthCancel`, `oauthInFlight`, `oauthFailed`.

- [ ] **Step 1: Write failing tests**: `it('shows Sign in when signed out')`; `it('shows the link with Open and Copy while waiting')` (notice with `url`); `it('shows a device code when the notice carries one')`; `it('renders a text field for a prompt and answers it')`; `it('shows Sign out when signed in and calls signOut')`; `it('shows the failure message and a Retry button')`; `it('cancels the attempt when unmounted mid sign-in')` (abort signal fired); `it('shows the in-progress message on ALREADY_IN_FLIGHT')`; and in `components.client.spec.tsx` `it('renders the card instead of a key input for the anthropic-oauth route')`.
- [ ] **Step 2: Run** the new specs. Expected: FAIL.
- [ ] **Step 3: Implement** the card as a small state machine over `operations.signIn` with an `AbortController` aborted in the effect cleanup; reuse existing button/field primitives and `Tooltip`; copy via `navigator.clipboard.writeText` in try/catch. In `ProviderEditor`, when `keylessNativeAuth` and an authorization key exists for the route, render the card where the key field would be; otherwise keep current behaviour.
- [ ] **Step 4: Run** package tests, `pnpm run typecheck`, `pnpm run lint`, coverage for the package. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui-settings-models): OAuth sign-in card`.

### Task 6: Goldens, gates and manual verification

**Files:**
- Modify: web e2e goldens for `apps/web/tests/models-settings.e2e.ts` and the `onboarding-usable-provider` e2e (one new option line `anthropicOauth` after `anthropic`); add an upgrade-guide note only if the repo rule applies (this is additive, so expected none).

- [ ] **Step 1:** Run `pnpm run test`, `pnpm run test:coverage`, `pnpm run typecheck`, `pnpm run lint`, `pnpm run duplication`, `pnpm run build`. Expected: all pass; fix anything reported.
- [ ] **Step 2:** Re-record only the affected goldens following the e2e files' own update instructions; diff must be exactly the added option line.
- [ ] **Step 3: Manual verification** (needs a real Anthropic account): start the app via the `dsh` profile (see `AGENTS.md` "Application launch"), open Settings → Models → Add provider, confirm `anthropicOauth` sits below `anthropic`, sign in through the shown link, add the route, send a message, then sign out and confirm the route reports signed-out. Report results honestly, including anything not run.
- [ ] **Step 4: Commit** `test: update models goldens for anthropicOauth`.
