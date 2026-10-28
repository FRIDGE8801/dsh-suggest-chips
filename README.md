# dsh-suggest-chips

Suggested-prompt chips for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

After every completed agent turn, a bounded auxiliary LLM call predicts 2–3 prompts you are likely to send next. The web chat renders them as clickable rows **under the newest turn** — inside the transcript, so they scroll away with the conversation. Clicking a chip sends that prompt immediately.

> Derived from [studyzy/dsh-suggest-prompt](https://github.com/studyzy/dsh-suggest-prompt) (MIT). This fork keeps the bounded generation pipeline but changes delivery and UI: suggestions live in the plugin's own storage domain (never in the session log) and render as clickable chips instead of ghost placeholder text.

## Features

- **One click to continue** — a chip fills the composer draft and submits it, exactly like typing the prompt yourself.
- **Not while you type, only when you send** — starting a reply leaves the chips visible, so you can change your mind and still click one; they disappear once your message is actually sent.
- **2–3 suggestions per turn** — the model returns a short ranked list (`maxSuggestions` defaults to `3`), best first.
- **In-transcript placement** — chips sit under the newest completed turn and scroll with the chat; they do not float over the composer.
- **Last turn only** — by default only the last completed turn's user message and assistant final answer are sent to the suggestion model (`maxRecentTurns: 1`); tool calls and reasoning are never included.
- **Fast and cheap** — the auxiliary call disables thinking (`reasoningEffort: off`); models that reject the field are retried once without it.
- **Bounded** — byte, token, timeout, transcript, suggestion-count and suggestion-length caps, all configurable.
- **Safe** — transcripts are secret-redacted before framing; output is sanitized (control sequences, fences, quotes stripped, single line) and semantically filtered (meta-text, evaluative filler, assistant-voice phrasing are dropped).
- **Silent when unsure** — an empty or rejectable reply means “no chips” for that turn: no error, no event, no noise.
- **Survives reloads** — the stored suggestion is re-read from disk after a reload or when the session is reopened.
- **Route configurable in the WebUI** — pick the suggestion provider/model on the **Plugins** page; by default it follows the session route.

## Requirements

- Node.js `^22.19` or `>=24`, pnpm.
- A dsh deployment (web-capable profile) on **dsh ≥ 0.2.0-rc.2**.
- Browser side: the `conversation.chat.turnTail` slot and the session-standard `inputActions` / `useChat` kit, both provided by `@deepseek-ai/dsh-client-ui-chat` in a standard web composition.

## Install

This repository is a **single bundle package**: the root `dsh-suggest-chips` declares `dsh.bundle` and ships its own `cordis.patch.yml`, so `dsh plugin add` installs it as one bundle layer of your profile.

```sh
# From GitHub
dsh plugin --profile desktop add https://github.com/FRIDGE8801/dsh-suggest-chips.git

# Local source (development)
dsh plugin --profile desktop add /path/to/dsh-suggest-chips
```

Replace `desktop` with your deployment's profile name (`web` for a `dsh web` install). Restart the running dsh service after installing.

Uninstall:

```sh
dsh plugin --profile desktop remove dsh-suggest-chips
```

> **pnpm ≥ 10 git note**: a git-hosted plugin builds on install through its `prepare` script, which pnpm blocks until allowed. If `add` fails, add the exact key pnpm printed to `allowBuilds` in `~/.dsh/profiles/<profile>/pnpm-workspace.yaml`, then re-run `add`.

## Configure

### Suggestion model (WebUI, day-to-day)

The **Suggested prompts** card lives on the **Plugins** page and appears in two places that share one form and one save path:

- the official **Suggested prompts** card;
- the installed `dsh-suggest-chips` package page, above its component list.

- **Provider / Model** — choose the route for the auxiliary call. Leave both empty to **follow the session route**; set them to use any registered provider/model.
- Edits are staged (**Unsaved** / Discard / Save); saving writes the `suggest-chips` entry config of the active profile and takes effect on the next completed turn — no restart.
- The dropdown lists only explicitly declared models; a provider without a declared list degrades to free-text input.
- Deployments without a settings service (e.g. headless) do not show the form; configure `provider` / `model` in the patch layer instead.

### Patch-layer fields (defaults ship with the bundle)

The bundle's `cordis.patch.yml` provides these defaults; override the same entry's `config` in your profile patch layer (`~/.dsh/profiles/<profile>/cordis.patch.yml`) if needed. Only `provider` / `model` are editable in the WebUI.

| Field | Meaning | Default |
|---|---|---|
| `maxInputBytes` | Maximum UTF-8 bytes in the framed user prompt | `4096` |
| `maxOutputTokens` | Suggestion output-token cap | `512` |
| `timeoutMs` | End-to-end auxiliary request deadline (ms) | `60000` |
| `maxRecentTurns` | Transcript tail keeps at most this many completed turns | `1` |
| `maxTranscriptChars` | Transcript character budget | `12000` |
| `maxSuggestionChars` | Visible-character cap per suggestion | `90` |
| `maxSuggestions` | Maximum suggestions per turn (1–5) | `3` |
| `provider` / `model` | Override the session route; omitted members inherit it | inherited |

> **On `maxOutputTokens`**: thinking is disabled by default, so reasoning does not consume the output budget. Models that cannot disable thinking fall back to a retry where thinking *does* spend budget — leave a generous cap (e.g. `512`) for such routes.

## How it works

- The host listens for `turn/end` with reason `completed`. Each completed turn gets at most one generation; the next completed turn aborts an in-flight call and retires the previous suggestion.
- Generation is bounded and pure: it reads a host-only transcript fold (last completed turn), redacts secrets, frames the request, disables thinking, enforces the deadline, then sanitizes and filters the reply.
- Suggestions are persisted in the plugin's **own storage domain** (`suggest_chips`) and served to the browser over `POST /api/suggest-chips` with `{ sessionId }`. **Nothing is written to the session log**, so a cold read can never fail on a plugin-private event type.
- The browser polls that route (700 ms) from the newest turn's tail entry only, so a long transcript still runs exactly one poller.
- Chips are visible only when all of the following hold: the turn is the newest completed one, the agent is idle, and the composer is not mid-submit. A non-empty draft does **not** hide them — you can start typing, change your mind, and still click a chip. They disappear when your message is sent.
- Clicking a chip sets the composer draft and submits it. Chips are plain buttons — no shortcut interception, no hidden state.
- The reply language follows the conversation: a CJK last user message yields Chinese suggestions, everything else English.

## Security

- **Redaction before send**: AWS `AKIA…`, OpenAI `sk-…`, GitHub `ghp_`/`gho_`/`ghu_`, Slack `xox-…`, JWT and Stripe `rk_…` shaped secrets are masked as placeholder tags.
- **Sanitized output**: ANSI/OSC/CSI/DCS sequences, C0/C1 controls, bidi overrides and lone surrogates are stripped; quotes and code fences are removed; each suggestion is collapsed to one line and truncated to `maxSuggestionChars`.
- **Semantic filtering**: meta-text (“no suggestion”, “stay silent”), error echoes, evaluative filler (“thanks”, “looks good”, 谢谢, 不错), assistant-voice phrasing (“Let me…”, “I'll…”, 我来, 我帮你), multi-sentence or over-long replies, and lone words are dropped as “no suggestion”.
- **No session-log writes** — suggestions cannot corrupt or block session history.
- The browser never sees model credentials; generation runs on the host with the deployment's own route.

## Limitations

- One suggestion set per completed turn. A superseded (aborted) generation leaves no chips for the earlier turn.
- An empty or filtered model reply means no chips for that turn; reopening the session will not retry.
- Chips appear only under the newest turn. Older turns keep no visible chips even if a suggestion was stored for them.
- The stored suggestion is model output: it can be plausible but wrong, and it is always shown as a suggestion, never auto-sent.
- Chips stay visible while you type; sending the draft is what retires them.

## Development

```sh
pnpm install
pnpm build          # host tsc + client tsdown bundle
pnpm typecheck
pnpm test           # vitest
pnpm verify:client  # executes lib/client.js against the browser kernel contract
pnpm check          # typecheck + test + build + verify:client
```

> The repo depends on published `@deepseek-ai/*` packages at `0.2.0-rc.2`. A few internal packages are not on the registry yet, so `pnpm.overrides` maps `dsh-compact`, `dsh-type-meta` and `dsh-environment` to empty local stubs and pins the whole `@deepseek-ai/dsh-*` set to `0.2.0-rc.2`. Both can be removed once the registry catches up.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the architecture rules and version-coupled contracts; changes are recorded in [CHANGELOG.md](CHANGELOG.md), security reports go through [SECURITY.md](SECURITY.md).

## Русский (кратко)

Плагин для DeepSeek Harness: после каждого завершённого хода агента модель предлагает 2–3 варианта следующего сообщения. Они показываются кликабельными строками **под последним ходом в чате** (прокручиваются вместе с перепиской) — клик сразу отправляет промпт.

**Установка:**

```sh
dsh plugin --profile desktop add https://github.com/FRIDGE8801/dsh-suggest-chips.git
```

После установки перезапустите dsh. Профиль (`desktop`, `web`, …) — тот, который использует ваша сборка.

**Настройка:** на странице **Plugins** есть карточка **Suggested prompts** — выберите provider/model для генерации (пусто = следовать маршруту сессии). Остальные лимиты (токены, таймаут, количество и длина подсказок) задаются в `cordis.patch.yml` профиля.

**Поведение:** подсказки видны только под последним завершённым ходом, когда агент не работает и поле ввода пустое. Клик подставляет текст в поле и отправляет его. Запрос проходит редактирование секретов, очистку и фильтрацию ответа; пустой или сомнительный ответ = подсказок нет. В журнал сессии ничего не пишется — хранение в собственном storage-домене плагина.

**Разработка:** `pnpm install && pnpm check`.

## License

MIT. Original work © 2026 studyzy ([dsh-suggest-prompt](https://github.com/studyzy/dsh-suggest-prompt)); this fork © 2026 FRIDGE8801. See [LICENSE](LICENSE).
