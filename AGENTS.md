# CODEBUDDY.md

This file provides guidance to CodeBuddy Code when working with code in this repository.

## Project overview

`dsh-suggest-prompt` is a single bundle plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (a Cordis-based agent framework)(local source code: `../../deepseek-harness/`). After every completed agent turn, a bounded auxiliary LLM call writes **one suggested next prompt** into the session log; the web composer renders it as ghost placeholder text inside the input, adopted via a configurable shortcut (default `Tab`).

This repo is the **authoritative source of record** for one bundle package `@studyzy/dsh-suggest-prompt` (a single-package bundle that declares `dsh.bundle` and ships its own `cordis.patch.yml`, so `dsh plugin add <git-url>` installs it as one profile layer). It merges the former two-package workspace into two runtime halves under one package:

| Half | Outlet | Role |
|---|---|---|
| host / node | `.`, `./invariant`, `./types` | On `turn/end` (reason `completed`), builds a bounded transcript, calls `ctx.llm`, sanitizes the reply, persists the suggestion as one ignorable plugin record, and publishes the `suggestPrompt` session projection. |
| browser | `./client` | Reads the `suggestPrompt` projection and renders it as ghost placeholder text in the composer (`conversation.input.overlay` slot), plus a WebUI settings card. |

## Commands

Requires Node `^22.19` or `>=24` and `pnpm`. Run everything from the repo root (single package, no workspace fan-out).

```sh
pnpm install        # uses pnpm.overrides mapping 3 unpublished @deepseek-ai packages to local empty stubs/ (and pinning @deepseek-ai/dsh-* to 0.2.0-rc.2)
pnpm build          # tsc -p tsconfig.json && tsdown: host ESM (lib/{index,invariant}.js) + browser bundle (lib/client.js)
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest run — the unit lane
pnpm verify:client  # execute the real lib/client.js through a stand-in module loader and check the browser-kernel contract
pnpm check          # typecheck + test + build + verify:client — the full local gate (mirrors CI's build job)
```

Run a single test file:

```sh
pnpm vitest run tests/sanitize.spec.ts
pnpm vitest run tests/ghost.client.spec.tsx
```

Two test lanes with separate Vitest configs:

- **Unit lane** (`vitest.config.ts`, `pnpm test`): `tests/**/*.spec.{ts,tsx}`. Excludes `**/tests/e2e/**` and the legacy manual `tests/provider.e2e.ts`.
- **E2E lane** (`vitest.e2e.config.ts`, `pnpm test:e2e` / `pnpm test:e2e:local`): `tests/e2e/**/*.e2e.ts` only. Spawns a **real** `dsh web` and drives the WebUI with Playwright; requires `DEEPSEEK_API_KEY` (suite is `skipIf`-gated on it).
  - `tests/e2e/suggest.e2e.ts` (CI lane): isolated `$DSH_HOME` in a tmpdir — never touches the real `~/.dsh`. Installs the bundle via `dsh plugin --profile web add`, walks the first-run onboarding to store the key, connects a workspace, sets the model on the 建议提示词 card, then asserts the ghost suggestion appears, the native placeholder is hidden (no double ghost text), and Tab adopts the suggestion. Failure evidence (screenshot + page-state JSON) is saved under `.artifacts/`.
  - `tests/e2e/suggest-local.e2e.ts` (local lane): runs against the developer's **real** `~/.dsh` and writes to the real `~/.dsh/settings.yaml` (an intentional side effect); assumes dsh is globally installed and already configured. Headful on macOS.
- In CI, the `build` job (typecheck/test/build on Node 22+24) is the **gate**; the e2e job is `continue-on-error` (needs the live model + secret) and is a signal only. CI installs with `--ignore-scripts` because the root `prepare` script runs `pnpm build`.

## Architecture

### Install / build caveats (important)

- The root `package.json` `pnpm.overrides` maps three unpublished upstream packages (`@deepseek-ai/dsh-compact`, `@deepseek-ai/dsh-type-meta`, `@deepseek-ai/dsh-environment`) to empty local packages under `stubs/` so `pnpm install` succeeds offline. Do not delete them until the registry is complete.
- `dsh.bundle` in `package.json` (`patch: ./cordis.patch.yml`) makes the package a one-command bundle: `dsh plugin --profile web add <git-url>` installs it and `reconcilePlugins` auto-appends it to the profile's `bundles` list. The browser half is discovered via the `dsh.client` declaration (`exports["./client"]`), so `cordis.patch.yml` only inserts the host entry. `dsh.client.inject` lists only the packages whose client bundle must be loaded first (`@deepseek-ai/dsh-client-ui-conversation`); the type-only `dsh-client-*` packages are deliberately not listed.
- The desktop profile (`~/.dsh/profiles/desktop`) is managed by the Electron app, so install it the same way a manual `link:` layer is composed: add a `link:` dependency plus a `dsh.profile.bundles` entry in the profile's `package.json`, and symlink the package into the profile's `node_modules/@studyzy/` (the desktop profile does not run `pnpm install` on demand). The app must be restarted for a newly linked bundle to load.
- The `vitest.config.ts` aliases the single package's outlets to their **source** (not `lib/`) and `inline`s `@deepseek-ai/dsh-client-*` deps so tests run against source without a prior build and so CSS modules resolve under jsdom.
- `scripts/verify-client-bundle.mjs` (`pnpm verify:client`) executes the **built** `lib/client.js` through a stand-in module loader: the bundle must register a factory under the plugin id, `require` only modules the shell seeds (the `PLATFORM_MODULES` list), and export the face the kernel activates; it also cross-checks that `dsh.client` and `exports["./client"]` agree. These contract violations fail only at page load for the user — not in `pnpm typecheck` / `test` / `build` — so run `verify:client` (or `pnpm check`) after touching the client bundle or the manifest.

### Host half (`src/`)

One file per responsibility:

- `index.ts` — the Cordis plugin `apply(ctx)`: refuses to mount on a harness without `appendPluginRecord` (warns once, wires nothing — see the records.ts entry), otherwise scopes the body to `sessionProjections`, wires the `turn/end` handler, dedup/abort state per session, and registers both projection units (`suggestPrompt` for the client, host-only `suggestPromptTranscript`). No settings-registration helper is needed in `dsh >= 0.2.0`: the entry's `config` **is** the settings-backed value, keyed by the profile entry id (`suggest-prompt`). The projection-key type merge is re-exported via `export type * from './types.ts'` at the package root.
- `types.ts` — single home of the `SuggestPromptSuggestion` / projection-key declarations shared by host and browser, plus the host-only `SuggestPromptTranscriptState`.
- `domain.ts` — the `SuggestPromptSuggested` record payload type, plus this package's `MessageSourceMap` entry (`kind: 'suggest-prompt'`) — `dsh >= 0.2.0` removed the catch-all `plugin` source kind.
- `records.ts` — the plugin-record seam: `SUGGEST_RECORD_TYPE` (`plugin:suggest-prompt/suggested`), the structurally-typed probe of the harness's `appendPluginRecord` (namespace import, because a named ESM import of a missing export fails at module link), `canAppendRecords()` (the dormancy gate), `appendSuggestedRecord`, and the read side (`suggestedRecordOf` + `isValidSuggestedPayload` — a restored record is owner-validated data an earlier build may have written). `useRecordWriterForTests` is the stand-in seam the pinned rc.2 devDependency needs.
- `transcript.ts` — the host-only `suggestPromptTranscript` fold: `applyTranscriptProjection` retains, per committed event, the newest completed turn, its start boundary, and the redacted user/assistant pairs inside a bounded window. This replaces the old `session.events` scan because `dsh >= 0.2.0` deprecates synchronous history reads for new production callers (see the harness note `2026-09-09-deprecate-synchronous-session-event-reads`).
- `generate.ts` — the bounded generation pipeline: config validation (`resolveSuggestPromptConfig`), transcript building over fold state, route resolution (inherits main request route when `provider`/`model` unset), deadline-fused dispatch via `ctx.llm`, and reasoning disabled (`ReasoningEffortId('off')`, retried once without the field if rejected). The only durable trace is the single suggestion record written through `appendSuggestedRecord`; nothing is logged pre-dispatch. `deepFreeze` comes from `@deepseek-ai/dsh-util-values` (it left `dsh-llm`).
- `sanitize.ts` — pure functions: `redactSecrets` (masks AWS/OpenAI/GitHub/Slack/JWT/Stripe secret shapes), `sanitizeSuggestion` (strips control sequences/fences/quotes, collapses to one line), `cleanSuggestion`, `shouldFilterSuggestion` (semantic filter: meta-text, evaluative filler, assistant voice → "no suggestion"), `hasCJK` (reply-language selection).
- `invariant.ts` — package invariant (fail-loud stream checks). It validates committed delivery only: an install-time scan of pre-existing sessions is prohibited now that synchronous history reads are deprecated.

### Browser half (`src/browser/`)

- `index.ts` — browser plugin `apply(ctx)`: registers `GhostSuggestion` into the `conversation.input.overlay` slot, and conditionally (via `ctx.inject(['configForms', 'locale'])`) mounts the `SettingsCard` twice on the Plugins page — once as a `plugins.item` card (`id: 'suggest-prompt'`, listed under the **已安装** grouping's sibling **官方** group, i.e. the official plugin cards) and once as `plugins.bundle.config` (`key: '@studyzy/dsh-suggest-prompt'`, the package name — a **keyed** slot addressed by package name, not by `id`/namespace) inside the detail page of the `@studyzy/dsh-suggest-prompt` **已安装 / Installed** package card, above its 包含的组件 / Components list. Re-exports `./types` so the `./client` outlet keeps exposing the `suggestPrompt` projection declaration.
- `GhostSuggestion.tsx` — the overlay bridge: reads `useProjection('suggestPrompt')` and shows ghost text while the agent is idle and the draft is empty. `turnEnds` no longer exists on the rc.2 Session snapshot, so freshness is derived from `running` rather than compared against a local completed-turn map. In-package types via relative `../types.ts` (no package self-import).
- `accept-key.ts` — parses the `acceptKey` config (default `Tab`) into a keyboard-shortcut matcher; ignores input while focused outside the composer or during IME composition.
- `settings-controller.ts` — `SuggestPromptCardController` for the WebUI settings card; reads/writes through the entry's `ConfigForm` (`ctx.configForms.get(SUGGEST_PROMPT_NS)`), staged saves take effect on the next completed turn.
- `settings-locales.ts` — `zh`/`en` locale dictionaries for the card.
- `SettingsCard.tsx` — the React settings card UI. The **same component is rendered by three surfaces** through the two slot registrations: `plugins.item` with `view: 'summary'` (the one-line description on the card, resolved from the `description` locale key), `plugins.item` with `view: 'page'` (the form inside the card's detail page), and `plugins.bundle.config` with `view: 'page'` (the form on the package detail page). It must branch on `view` — and because the `summary` branch would otherwise change the hook count between renders (React throws on "Rendered fewer hooks than expected"), summary is a separate hook-free component rather than an early return before the existing hooks.

### Version-critical contracts (`dsh 0.2.0-rc.2`)

These are the seams that broke on the 0.1.1 → 0.2.0 upgrade; keep them in sync when the harness advances:

- **Client module table is a fixed seed list.** A fetch bundle may only `require` the platform singletons in the harness's `PLATFORM_MODULES`: `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`, `@deepseek-ai/dsh-client-ui-dockkit`. Anything else throws at load. `CLIENT_EXTERNALS` in `tsdown.config.ts` mirrors that list; `@deepseek-ai/dsh-client-runtime` no longer exists (its `createSnapshotStore` moved to `dsh-client-store`), and the `dsh-client-*` packages used for types only must stay off the externals list.
- **`ctx.slots` comes from `dsh-client-ui-renderer/client`** (a type-only import), and slot faces are produced by each registration's `inject` callback rather than by package-level standard hooks.
- **Settings** are the profile entry's config: the host plugin's `Config` schema IS the settings page, and `ctx.configForms.get<T>(ns)` is the client read/write face.
  - The card's surfaces are the **Plugins page** slots `plugins.item` + `plugins.bundle.config` (they replaced `settings.plugins.tab`): `plugins.item` is a list slot addressed by `id` (plus an optional `label` thunk resolved through the locale), while `plugins.bundle.config` is a **keyed** slot addressed by the bundle's package name — writing `id` there (or the namespace `suggest-prompt` as the key) fails silently and the config area never renders. A profile bundle that is both a `bundles` member and a `dependencies` member is listed as *installed*, so it gets a package card in the installed group **in addition to** the official card — hence the two registrations, and hence both are required.
  - **Both surfaces must share one face.** The registration's `inject` callback is called per surface, so `inject: () => face` built once (`const face = settings.inject()`) is what makes a draft edited in one place visible in the other and makes Save a single revision-fenced write. Building a fresh face per call (`inject: () => settings.inject()`) does not error: each surface keeps its own draft table, edits made in one are invisible in the other, and saving from the stale one writes its own draft back.
  - A field reaches that page **only if it is marked `volatile()`** (`@deepseek-ai/schemastery >= 3.18.3`). An entry with no volatile field is omitted from `settings.describe` entirely, so the client card mounts and then renders nothing — a silent failure with no error anywhere. Only genuinely user-editable preferences should be volatile; composition bounds stay plain so they do not become form fields.
  - A volatile field is handed to the plugin as a live **reference** (`{ get(), set() }`), not the value itself. `resolveSuggestPromptConfig` unwraps every field at the config boundary (`unwrapVolatileFields`); reading one as a plain value yields `[object Object]` or fails validation. This is also why `Config` is declared separately from its schema — `volatile()` brands its output type, which would otherwise leak into every consumer of the runtime policy type.
- **Projections**: `init(header, inheritedEventCount)`, `wire` fields are `readonly`, `stateVersion` must be a non-negative integer, and `ctx.sessionProjections.stateOf(session, key)` is the read face used in place of session-history scans.

### Key invariants / behavioral rules

- **Last turn only**: by default only the last completed turn's user input + assistant final answer are sent (`maxRecentTurns` default `1`); intermediate tool calls/reasoning are never included.
- **Silent no-suggestion is normal**: empty or filtered model replies skip quietly — no record, no warning, projection stays `null`.
- **One in-flight generation per session**; the next completed turn aborts (supersedes) the previous one.
- **One ignorable record, nothing else**: the suggestion is persisted via `appendPluginRecord` as `plugin:suggest-prompt/suggested` (`src/records.ts`; `dsh >= 0.2.1`). No other session-log write is ever made — private `SessionEventMap` events wedged sessions on cold read (issue #4). On a harness without the record API (0.2.0-rc.2) the plugin is fully dormant: `apply` warns once and wires nothing.
- **Re-arm without a call**: deleting back to an empty draft re-shows the persisted suggestion with no new model request.
