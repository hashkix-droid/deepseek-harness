# Design: `anthropicOauth` provider route with OAuth sign-in

Date: 2026-11-07 · Status: draft for review

## Goal

On Settings → Models → Add provider, offer a new entry labelled **anthropicOauth** directly below **anthropic**. Selecting it lets the user sign in to Anthropic with OAuth from the page, and the resulting route sends requests with the stored, auto-refreshed OAuth credential. It is a separate route: it coexists with an API-key `anthropic` route.

## What exists today (verified in source)

- `packages/llm/llm-pi-ai/src/login.ts` registers a `ctx.authorization` flow per pi-ai catalog provider that ships a login. For `anthropic` it offers an `oauth` method (and `api-key`). pi-ai persists the credential through the shared store in `auth.ts`, keyed by `recordKeyFor(providerId)`, and refreshes it inside `modify()`.
- `packages/credentials/authorization` (`AuthorizationService`): `list`, `describe`, `begin`, `cancel`; flows report `notify` notices (url, code) and `prompt` questions; `authorization/settled` event.
- Provider directory (`llm-pi-ai/src/index.ts#directoryEntries`) feeds the Add-provider `<select>` in `ModelsSection.tsx`. `ProviderEditor.tsx` already hides the key input when `nativeAuth = { env: [], oauth: true }` ("keylessNativeAuth").
- **Gaps:** (1) no Remote namespace exposes `ctx.authorization` to the client; (2) no sign-in UI in `ui-settings-models`; (3) the route key doubles as pi-ai provider id and credential-record key, so an OAuth-only twin of `anthropic` does not exist as a route.

## Decisions

1. **Route key `anthropic-oauth`, display name `anthropicOauth`.** Credential-record keys must satisfy `isCredentialKeySegment` (lowercase, hyphenated); `login.ts` skips ids that don't. The picker shows `displayName`, so the user sees exactly `anthropicOauth`.
2. **Alias route in `llm-pi-ai`.** A small table `ROUTE_ALIASES` maps `anthropic-oauth` → `{ base: 'anthropic', displayName: 'anthropicOauth', auth: 'oauth-only' }`. The alias provider is the installed `anthropic` provider re-identified (`id: 'anthropic-oauth'`) with `auth` reduced to its `oauth` member (no api-key method), so its models, protocol quirks and streaming are the catalog's, unchanged. Model resolution (`resolveRouteModels`) and `catalogProvider()` resolve an alias to its base's catalog.
3. **Separate credential record** `llm-pi-ai/anthropic-oauth`. An `anthropic` route may hold an API key in `llm-pi-ai/anthropic` while `anthropic-oauth` holds a grant; they never overwrite each other.
4. **Directory entry** inserted immediately after `anthropic` (Map insertion order in `directoryEntries`), `declared: false`, `nativeAuth: { env: [], oauth: true }`, base URL defaults from the base provider.
5. **Authorization flow** registered for the alias key with a single `oauth` method, run through the existing `registerPiAiFlows` machinery (generalised to iterate catalog ids plus aliases).
6. **New Remote namespace `authorization`** (new package `packages/api/authorization-controller`, following `credentials`' `TypertRemoteService` pattern, wired into the same gateway/bundle compositions as `settings-controller`):
   - `list(): { key, label, methods, inFlight, signedIn }[]`; `signedIn` = the record exists (no secret returned).
   - `begin(key, method?)` — `@Remote({ mode: 'stream' })` yielding `{ type: 'notice', message, url?, code? }`, `{ type: 'prompt', promptId, kind, message, placeholder?, options? }`, then a final `{ type: 'settled', status }`; errors map to `RemoteError` with the seam's message.
   - `answer(key, promptId, value)` resolves a pending prompt; `cancel(key)` aborts the attempt (stream abort also cancels).
   - `signOut(key)` deletes the record (idempotent).
   - Validation: key must be a flow-registered key; payload sizes bounded; no method ever returns a token.
7. **Client sign-in card** in `ui-settings-models`: shown by `ProviderEditor` when the route's `nativeAuth` is keyless OAuth. States: signed out → **Sign in** → waiting (shows the authorization link with Open and Copy buttons, any device code, and a text field for a pasted code when the flow prompts) → signed in (**Sign out**) / failed (message + retry). `ModelsOperations` gains `authorization` calls; strings added to the models locale files (English and Chinese, per repo i18n convention).
8. **Adding flow:** user picks `anthropicOauth`, signs in on the add card, then Apply writes the profile. Apply is allowed before sign-in too; the card then shows signed-out status.

## Data flow

Add card → `authorization.begin('…/anthropic-oauth')` stream → host `AuthorizationService.begin` with an interaction that pushes notices/prompts onto the stream → pi-ai `models.login(…, 'oauth')` → grant committed via the credential store → `credentials/record-updated` (already forwarded) → card refreshes `signedIn`. Requests: `PiAiAdapter` resolves the route through the shared store, pi-ai refreshes the grant inside `modify()`.

## Error handling

- Flow failure, decline, or cancel surfaces as a message on the card; the card can retry. A second `begin` while in flight returns `ALREADY_IN_FLIGHT`, shown as "sign-in already in progress".
- Closing the editor or dropping the stream cancels the attempt.
- A request on a route with no grant fails with the existing missing-credential error; the card's signed-out state is the recovery path.

## Testing

- `llm-pi-ai`: directory order and entry shape; alias provider has no api-key auth and base models; login registers the alias flow; two records coexist; existing tests unchanged.
- `authorization-controller`: list/begin/answer/cancel/signOut, validation, no secret in any result (100% coverage gate).
- `ui-settings-models`: card state machine component tests; picker lists the entry below anthropic.
- Update `models-settings` and `onboarding-usable-provider` web e2e goldens (they gain one option line).
- Manual: run the app, sign in with a real Anthropic account, send a message, confirm refresh after expiry is not regressed.

## Risks and open verification gates

These are checked first during implementation; a failure stops and returns to design.
- pi-ai's Anthropic OAuth `login` must work when the provider is re-identified; if it hard-codes `anthropic` anywhere, the alias will wrap rather than copy the provider.
- Anthropic's terms govern third-party use of subscription OAuth tokens; availability of the grant for API traffic is outside this repo's control.
- Every wiring point for a new Remote namespace (generated client types, gateway allow-lists, bundles) is found by following `credentials` end to end.

## Out of scope

OAuth entries for other providers (the mechanism is generic; only `anthropic-oauth` is added), migrating existing records, and changes to the DeepSeek account sign-in.
