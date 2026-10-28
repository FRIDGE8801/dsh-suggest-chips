# Contributing

Thanks for your interest in `dsh-suggest-chips`. This document covers the
practical rules for changing the repo; the architecture itself lives in
[AGENTS.md](AGENTS.md).

## Prerequisites

- Node `^22.19` or `>=24`
- `pnpm` (the exact version is pinned by `packageManager` in `package.json`)

## Setup

```sh
pnpm install       # maps three unpublished @deepseek-ai packages to local stubs/
pnpm typecheck
pnpm test
pnpm build
pnpm verify:client
```

`pnpm install` uses `pnpm.overrides` to map three upstream packages that are not
on the npm registry to empty local packages under `stubs/`, and pins the
`@deepseek-ai/dsh-*` set to the targeted release. That is expected, not a
workaround you should remove.

## The gates

Every change must pass all of them; `pnpm check` runs the whole set:

```sh
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest run (unit, jsdom)
pnpm build          # tsc -> lib/types, tsdown -> lib/{index,invariant,client}.js
pnpm verify:client  # execute the built client bundle against the browser contract
```

Run a single test file while iterating:

```sh
pnpm vitest run tests/sanitize.spec.ts
```

## Version-coupled code (read before editing)

This plugin is built against a **specific** `dsh` release, and the harness
changes its internal contracts between releases. The seams that have already
broken once are documented in [AGENTS.md](AGENTS.md) under
"Version-critical contracts". A few are easy to get wrong:

- **The client module table is a fixed seed list.** A browser bundle may only
  `require` the platform singletons listed in the harness's `PLATFORM_MODULES`.
  Requiring anything else throws at load time. `CLIENT_EXTERNALS` in
  `tsdown.config.ts` mirrors that list.
- **The chip seat is `conversation.chat.turnTail`**, a session-scoped slot
  rendered per completed turn inside the transcript. Its entries are direct flex
  children of the turn-tail root, and the slot passes the standard session kit
  (`useChat`, `inputActions`, `sessionId`). Do not move chips back into a
  composer overlay: they must scroll with the chat.
- **Only the newest turn may poll the host.** `SuggestionChips` gates on
  `useChat(snapshot => snapshot.timeline.turnOrder.at(-1))`; removing that gate
  mounts one 700 ms poller per turn in a long transcript.
- **Settings surfaces are the Plugins page seats** `plugins.item` (by `id`) and
  `plugins.bundle.config` (keyed by the npm package name). Both must inject the
  same controller face; a fresh face per registration silently splits staged
  edits. Only `volatile()` fields appear in the form.
- **Never write to the session log.** Suggestions are stored in the plugin's own
  storage domain. Appending a plugin-private event type is what made sessions
  unreadable on cold read (issue #4).

When you adapt to a new harness release, update the affected `@deepseek-ai/*`
ranges, the `pnpm.overrides` pin, `AGENTS.md`, and the contract tests together.

## Tests

- Add a regression test for every bug fix. UI contracts in this project are
  checked by unit tests and by `verify:client`; a change that only “looks right”
  in the browser but is untested is likely to regress silently.
- `scripts/verify-client-bundle.mjs` executes the real `lib/client.js` through a
  stand-in module loader and asserts the registrations the Plugins page and the
  chat renderer require. Run it after touching the client bundle or `package.json`.
- There is no e2e lane: tests never spawn a real `dsh` or call a live model.

## Commits and pull requests

- Conventional-commit subjects (`fix:`, `feat:`, `docs:`, `test:`, `chore:`,
  `refactor:`) keep the history scannable.
- Keep a commit focused; unrelated cleanups belong in their own PR.
- Fill in the pull request template, including the **Breaking changes** section
  when you touch the bundle's public surface, the `suggest-chips` config schema,
  or the browser route contract.
- Note in the PR how you verified the change. "Ran `pnpm check`" is enough for a
  small fix; contract changes should say what you checked against the harness
  source.

## Reporting bugs

Use the issue templates. For a behavior difference after a `dsh` upgrade,
include the harness version — most reports of this kind are a contract drift
rather than a logic bug.
