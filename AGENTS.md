# AGENTS.md

Guidance for coding agents working in this repository.

## Project overview

`dsh-suggest-chips` is a single bundle plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (Cordis-based). After every completed agent turn, a bounded auxiliary LLM call predicts 2–3 next prompts. The host persists them in the plugin's own storage domain and serves them to the browser over a plugin-owned fetch route; the web chat renders them as clickable chips under the newest turn, and a click sends the prompt immediately. The session log is never written.

The package merges two runtime halves under one bundle (`dsh.bundle` + `cordis.patch.yml`):

| Half | Outlet | Role |
|---|---|---|
| host / node | `.`, `./invariant`, `./types` | On `turn/end` (reason `completed`), builds a bounded transcript, calls `ctx.llm`, sanitizes the reply, persists the suggestion set in the plugin's own storage domain, and serves it over `POST /api/suggest-chips`. Writes NOTHING to the session log. |
| browser | `./client` | Polls the host route and renders the stored suggestions as clickable chip rows in the newest completed turn's tail (`conversation.chat.turnTail`), plus the configuration card on the Plugins page. |

## Commands

Requires Node `^22.19` or `>=24` and `pnpm`. Run from the repo root (single package, no workspace fan-out).

```sh
pnpm install        # pnpm.overrides map 3 unpublished @deepseek-ai packages to local stubs/ and pin @deepseek-ai/dsh-* to 0.2.0-rc.2
pnpm build          # tsc -p tsconfig.json && tsdown: host ESM (lib/{index,invariant}.js) + browser bundle (lib/client.js)
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest run — the unit lane
pnpm verify:client  # execute the real lib/client.js through a stand-in module loader and check the browser-kernel contract
pnpm check          # typecheck + test + build + verify:client — the full local gate
```

Run a single test file:

```sh
pnpm vitest run tests/sanitize.spec.ts
```

There is one test lane: `vitest.config.ts` includes `tests/**/*.spec.{ts,tsx}`, aliases `dsh-suggest-chips/*` to source (not `lib/`), and inlines `@deepseek-ai/dsh-client-*` so tests run without a prior build and CSS resolves under jsdom. There is no e2e lane; UI behavior is verified by unit/contract tests plus `verify:client`.

## Architecture

### Install / build caveats

- `pnpm.overrides` maps three unpublished upstream packages (`@deepseek-ai/dsh-compact`, `@deepseek-ai/dsh-type-meta`, `@deepseek-ai/dsh-environment`) to empty local packages under `stubs/`, and pins `@deepseek-ai/dsh-*` to `0.2.0-rc.2`. Do not delete until the registry is complete.
- Harness packages stay in `peerDependencies` (plus `devDependencies` for the local build) and never in `dependencies`: a hoisted plugin copy makes the host evaluate that copy's exact dsh peers, refuse them, and disable profile rows. `tests/package-manifest.spec.ts` enforces this.
- `dsh.bundle` (`patch: ./cordis.patch.yml`) makes the package a one-command bundle: `dsh plugin --profile <profile> add <git-url>` installs it as one profile layer. The browser half is discovered via `dsh.client` (`exports["./client"]`), so the patch only inserts the host entry. `dsh.client.inject` lists the client bundles that must load first — currently `@deepseek-ai/dsh-client-ui-conversation` and `@deepseek-ai/dsh-client-ui-chat` (the seat that declares `turnTail` lives in ui-chat). Type-only `dsh-client-*` packages are deliberately not listed.
- The desktop profile (`~/.dsh/profiles/desktop`) is managed by the Electron app: add a `link:` dependency plus a `dsh.profile.bundles` entry and symlink the package into the profile's `node_modules/`. The app must be restarted (or reloaded) for a newly linked bundle to load.
- `scripts/verify-client-bundle.mjs` (`pnpm verify:client`) executes the built `lib/client.js` through a stand-in module loader: the bundle must register a factory under the plugin id, `require` only shell-seeded platform modules, export `apply`/`inject`, register the `turnTail` entry and both Plugins-page settings seats, and share one controller face across them. These violations fail only at page load — not in typecheck/test/build — so run `verify:client` after touching the client bundle or manifest.

### Host half (`src/`)

- `index.ts` — the Cordis plugin `apply(ctx)`, `inject: ['llm', 'sessions', 'storageDomain', 'connection']`. The body is scoped to `sessionProjections` (generation reads the host-only transcript fold). It opens the suggestion domain once per mount (single-flight promise), listens for `session/event`:
  - `turn/start` aborts the session's in-flight generation;
  - `turn/end` with reason `completed` starts one generation (deduped per session + turn, superseded by the next completed turn).
  Durable mutations are serialized through `mutate()` so an older asynchronous put cannot win last. It registers two host-only projection units (`suggestPromptTranscript` fold, `suggestPromptLifecycle` fold) and one `ctx.connection.fetch.register(...)` route for the browser read.
  **Never `connection.rpc.handle`**: it registers through the *connection service's own fiber*, which never injects `webServer`, so it throws regardless of this plugin's `inject` list. `connection.fetch.register` writes only to the connection's own route table; its path must sit under `/api` (`assertFetchRoute`). Per-session generation state is in a `WeakMap`; config is re-resolved at each turn so a settings edit lands on the next completed turn.
- `types.ts` — the shared `SuggestPromptSuggestion` payload (`turn`, `baseSeq`, `suggestions[]`, optional `route`) and the host-only `SuggestPromptTranscriptState`. No client-visible projection key: the browser reads the fetch route.
- `domain.ts` — the durable record contract (`SuggestPromptStorageRecord`, version 2), deliberately distinct from the payload, plus this package's `MessageSourceMap` entry (`kind: 'suggest-chips'`) because `dsh >= 0.2.0` removed the catch-all `plugin` source kind.
- `records.ts` — the durable store: `suggestPromptDomainSpec` (`defineDomain({ name: 'suggest_chips', version: 1, layout: 'per-record', invalidRecords: 'backup-and-skip', ... })`) plus `readSuggestion` / `writeSuggestion` / `clearSuggestion` / `toStoredRecord` / `toSuggestion`. Records are validated with zod at the durable boundary and re-validated on read.
- `transcript.ts` — the host-only `suggestPromptTranscript` fold: retains the newest completed turn, its start boundary, and the redacted user/assistant pairs within a bounded window (roughly the last four turns). This replaces `session.events` scans, which `dsh >= 0.2.0` deprecates for new production callers.
- `generate.ts` — the bounded generation pipeline: config validation and volatile unwrapping (`resolveSuggestPromptConfig`), transcript pairing and framing, route resolution (inherits the main request route when `provider`/`model` is unset), deadline-fused dispatch via `ctx.llm`, and thinking disabled (`ReasoningEffortId('off')`, retried once without the field if the model rejects it). Generation is PURE with respect to durability: it returns the suggestion record; `index.ts` persists it. The system prompt forces a JSON array of 2–`maxSuggestions` candidates, and the reply language follows the conversation (CJK → Chinese, else English).
- `sanitize.ts` — pure functions: `redactSecrets` (AWS/OpenAI/GitHub/Slack/JWT/Stripe shapes), `sanitizeSuggestion` (strips control sequences/fences/quotes, collapses to one line), `cleanSuggestion`, `shouldFilterSuggestion` (meta-text, evaluative filler, assistant voice → “no suggestion”), `hasCJK`, `parseSuggestionList`.
- `invariant.ts` — runtime enforcement of the session-log prohibition: any committed event whose type starts with `suggest-chips/` or `plugin:suggest-chips/` fails. Only committed events are checked; scanning pre-existing history is deprecated.
- `rpc-contract.ts` — import-free constants shared by both halves: `SUGGEST_ROUTE_PATH = '/api/suggest-chips'`, `SUGGEST_ROUTE_METHOD = 'POST'`, `SUGGEST_RPC_GET`.

### Browser half (`src/browser/`)

- `index.ts` — browser plugin `apply(ctx)`: registers `SuggestionChips` into `conversation.chat.turnTail` (`id: 'suggest-chips'`, order 30), and, behind `ctx.inject(['configForms', 'locale'])`, registers the settings card on both Plugins-page seats — `plugins.item` (id `suggest-chips`, label through the locale) and `plugins.bundle.config` (key `dsh-suggest-chips`, the npm package name — a **keyed** slot, not `id`). Both registrations inject the **same** controller face. Re-exports `./types` so the `./client` outlet exposes the shared payload types.
- `SuggestionChips.tsx` — the chip row. The outer component subscribes only to the latest turn (`useChat(s => s.timeline.turnOrder.at(-1))`) and renders nothing for any other turn, so a long transcript mounts exactly one poller. The inner component filters the stored suggestion by `stored.turn === turn`, reads `running`/`phase`, and renders only when the agent is idle and the phase is `plain`; the draft is deliberately ignored, so typing does not hide the chips. A click calls `inputActions.setDraft(text)` then `queueMicrotask(() => inputActions.submit())`, guarded by a 3 s send lock. CSS is injected once via a ref-counted `<style id="dsh-suggest-chips-style">`; the root uses `order: 2` to sit below the message action row in the turn-tail flex column and `padding: 8px 0 50px` for the gap to the composer.
- `suggestion-source.ts` — the browser read path: `fetchSuggestion` POSTs `{ sessionId }` and `useStoredSuggestion` polls it (`POLL_INTERVAL_MS = 700`) while mounted, comparing shallowly so an unchanged payload keeps its reference and never piling up overlapping reads. Payloads are validated (`isSuggestion`) before they can become chip text. Every failure mode returns `null` — a broken read degrades to “no chips”. Uses plain `fetch`, so the module imports no `dsh-client-*` package at runtime.
- `settings-controller.ts` — `SuggestPromptCardController` over the entry's `ConfigForm` (`ctx.configForms.get('suggest-chips')`). Edits are staged; a save writes the route pair and the host resolves it on the next completed turn. Dropdown catalogs are read read-only from the `llm-pi-ai` and `llm-deepseek` sections. `SUGGEST_PROMPT_NS = 'suggest-chips'`.
- `settings-locales.ts` — `zh`/`en` dictionaries for the card, registered under `suggest-chips.settings`.
- `SettingsCard.tsx` — the React card. The page renders the same component through three surfaces: `plugins.item` + `view: 'summary'` (one-line description), `plugins.item` + `view: 'page'` (form), and `plugins.bundle.config` + `view: 'page'` (package page form). It branches on `view`; the summary branch is a separate hook-free component so the hook count never changes between renders.
- `plugins-page-slots.d.ts` — type-only declarations of the two Plugins-page slots this plugin registers into.

### Version-critical contracts (`dsh 0.2.0-rc.2`)

These seams broke on previous upgrades; keep them in sync when the harness advances:

- **Client module table is a fixed seed list.** A browser bundle may only `require` `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`, `@deepseek-ai/dsh-client-ui-dockkit`. `CLIENT_EXTERNALS` in `tsdown.config.ts` mirrors that list; type-only `dsh-client-*` packages must stay off it.
- **`ctx.slots` comes from `dsh-client-ui-renderer/client`** (type-only), and slot faces are produced by each registration's `inject` callback.
- **Chip seat**: `conversation.chat.turnTail` is a session-scoped list slot rendered per completed turn inside the transcript, with owner props `{ turn, seq, openFile }` and the standard session kit (`useSession`, `useInput`, `inputActions`, `sessionId`, and ui-chat's `useChat`). The slot outlet is `display: contents`, so list entries are direct flex children of the turn-tail root — hence CSS `order` can place the chips after the message actions. Entries that render `null` leave no gap.
- **Settings** are the profile entry's config: the host plugin's `Config` schema IS the settings page, and `ctx.configForms.get<T>(ns)` is the client read/write face.
  - The card's seats are the **Plugins page** slots `plugins.item` + `plugins.bundle.config`. `plugins.item` is a list slot addressed by `id` (with an optional `label` thunk resolved through the locale); `plugins.bundle.config` is a **keyed** slot addressed by the bundle's package name — writing `id` there (or the namespace as the key) fails silently and the configuration area never renders. A profile bundle that is both a `bundles` and a `dependencies` member gets a package card in addition to the official card, hence both registrations.
  - **Both surfaces must share one face.** `inject` is called per surface; build it once (`const face = settings.inject()`) so a draft staged in one place is visible in the other and Save is one revision-fenced write. A fresh face per call silently splits the staged-edit table.
  - A field reaches the page **only if it is marked `volatile()`** (`@deepseek-ai/schemastery >= 3.18.3`). An entry with no volatile field is omitted from `settings.describe` entirely, so the card mounts and renders nothing. Only user-editable preferences should be volatile; composition bounds stay plain.
  - A volatile field arrives as a live **reference** (`{ get(), set() }`). `resolveSuggestPromptConfig` unwraps every field at the config boundary (`unwrapVolatileFields`). This is why `Config` is declared separately from its schema — `volatile()` brands its output type.
- **Projections**: `init(header, inheritedEventCount)`, `wire` fields are `readonly`, `stateVersion` must be a non-negative integer, and `ctx.sessionProjections.stateOf(session, key)` is the read face used in place of session-history scans.

### Key invariants / behavioral rules

- **Last turn only**: by default only the last completed turn's user input + assistant final answer are sent (`maxRecentTurns` default `1`); tool calls and reasoning are never included.
- **Silent no-suggestion is normal**: an empty or filtered model reply skips quietly — no record, no warning; the endpoint keeps answering `null`.
- **One in-flight generation per session**: the next completed turn (or `turn/start`) aborts the previous call. A superseded generation writes nothing.
- **A retired suggestion is never served**: the moment a completed turn begins generating, the host clears the previous record (`retirePrevious`) before calling the model, so the browser answers `null` instead of showing the superseded chips for the model's whole latency. A duplicate `turn/end` for an already-answered turn short-circuits in `alreadySuggested` and clears nothing.
- **Zero session-log writes**: the suggestion is persisted in the plugin's own storage domain and served over `connection.fetch`. Private `SessionEventMap` types are outside the harness's closed `KNOWN_SESSION_EVENT_TYPES`; `0.2.0-rc.2` cannot mark an appended event `ignorable`, so one such event made the whole log unreadable on cold read (issue #4). `src/invariant.ts` enforces this at runtime.
- **Chips are the newest turn's, and only while idle**: `SuggestionChips` returns null for non-latest turns, for a running agent, and outside the `plain` input phase. A non-empty draft deliberately keeps them visible — typing must not discard the tips before the user decides to send; sending (a non-plain phase) hides them.
- **Click sends immediately**: `inputActions.setDraft` followed by a microtask `submit()`, with a 3 s lock against double submission. No shortcut interception, no auto-retry.
- **2–`maxSuggestions` suggestions**: the system prompt asks for a JSON array of 2..`maxSuggestions` (default 3), each at most `maxSuggestionChars` (default 90) visible characters; `parseSuggestionList` enforces both caps.
