# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Because this plugin is built against a specific `dsh` release and the harness
changes internal contracts between releases, each entry names the harness
version it targets.

> Earlier versions (≤ 1.2.3) belong to the upstream project,
> [studyzy/dsh-suggest-prompt](https://github.com/studyzy/dsh-suggest-prompt).
> This repository starts its own history at 0.1.0.

## [Unreleased]

### Changed

- Chips stay visible while the composer has text and are retired only after the
  message is sent (the submission phase leaves `plain`). Starting a reply no
  longer discards the tips, so the user can change their mind and still click
  one.

## [0.1.0] - 2026-10-28

Targets `dsh 0.2.0-rc.2`.

The first release of this fork. The bounded generation pipeline (transcript
fold, redaction, deadline, sanitization, semantic filtering, storage-domain
persistence) is carried over from upstream; delivery and UI are new.

### Added

- **Clickable suggestion chips under the newest turn.** After a completed turn
  the model proposes 2–3 next prompts (default `maxSuggestions: 3`). They render
  inside the transcript as clickable rows with a leading arrow, so they scroll
  away with the chat instead of floating over the composer. A click fills the
  composer and submits immediately.
- **`conversation.chat.turnTail` registration.** Chips belong to the newest
  completed turn; older turns and superseded generations show nothing. The row
  sits below the message action row (`order: 2`) with a 50 px gap to the
  composer.
- **Settings card on the Plugins page** for the suggestion provider/model,
  available both as the official **Suggested prompts** card and on the
  installed package page. Drafts are shared between the two surfaces and saved
  as one revision-fenced write; the route takes effect on the next completed
  turn.
- **`maxSuggestions` config field** (1–5, default 3) and a JSON-array reply
  contract from the suggestion model.

### Changed

- **Suggestions are delivered over the plugin's own fetch route**
  (`POST /api/suggest-chips`) from the plugin's storage domain. The browser
  polls it at 700 ms from the newest turn's tail entry only.
- **The plugin is now `dsh-suggest-chips`** (package, entry id, settings
  namespace). Installation is a single bundle layer via `dsh plugin add`.
- **Chip visibility rules**: only while the newest turn is completed, the agent
  is idle, the draft is empty, and the input is in the plain phase. Typing
  hides the chips; clearing the draft brings the stored set back without a new
  model call.

### Removed

- Ghost placeholder text, the composer overlay slot, keyboard-shortcut
  adoption (`acceptKey`), the composer toolbar Accept/Suggest buttons, and the
  on-demand generation endpoint.
- The Playwright e2e lane (`tests/e2e/`, `vitest.e2e.config.ts`, `test:e2e*`
  scripts). UI contracts are checked by unit tests and `pnpm verify:client`.
- Stale Chinese usage guide and screenshots from the upstream README.

### Fixed

- **Cold-read safety.** Nothing is written to the session log, so a
  plugin-private event type can never make a stored session unreadable
  (upstream issue #4). The runtime invariant rejects any
  `suggest-chips/`-shaped session event.
- **Stale suggestions are retired at the start of the next generation**, so the
  browser never serves the previous turn's chips during the model's latency.
