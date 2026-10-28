/**
 * Suggested-next-prompt chips: reads the host's STORED suggestions over the
 * plugin's own `/api` route and renders up to `maxSuggestions` clickable rows
 * under the transcript's last turn (`conversation.chat.turnTail`), so the tips
 * scroll away with the chat instead of hovering above the composer. Clicking a
 * row sends that prompt immediately: `setDraft(text)` followed by `submit()`,
 * i.e. the same path the send button takes — no synthetic key events.
 *
 * The host stores each set under the turn whose completion produced it, so a
 * tail only ever renders the set for its own turn. Only the latest tail reads
 * the store: every completed turn has a tail, and mounting the poll in each
 * would put one loopback poller per history row on the session.
 *
 * Chips are shown while the agent is idle, the draft is empty, and no chip is
 * already being sent. A send hides them until the next turn starts; the host
 * retires the previous record as soon as that turn completes, so a stale tip is
 * never offered for the new turn.
 */
import { useEffect, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
// Type-only: merges `useSession` and `sessionId` into the session standard props.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { SuggestPromptSuggestion } from '../types.ts'
import { useStoredSuggestion } from './suggestion-source.ts'

/** Full props of the chip row: turn-tail owner plus the session standard kit. */
export type SuggestionChipsProps = PropsRuntime<'conversation.chat.turnTail'>

const STYLE_TAG_ID = 'dsh-suggest-chips-style'
let styleUsers = 0

const CSS_TEXT = `
.dsh-suggest-chips {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  /* The turn-tail row renders the message actions before the slot body; a
     higher order keeps the tips below those actions, as the transcript's last
     row. In a non-flex parent the declaration is simply ignored. */
  order: 2;
  padding: 8px 0 50px;
}
.dsh-suggest-chip {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  box-sizing: border-box;
  margin: 0;
  padding: 7px 12px;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-quaternary, rgba(160, 160, 160, 0.55));
  font: inherit;
  font-size: 13px;
  line-height: 1.45;
  text-align: left;
  white-space: normal;
  overflow-wrap: anywhere;
  cursor: pointer;
  transition: color 0.12s ease;
}
.dsh-suggest-arrow {
  flex: none;
  width: 14px;
  height: 14px;
  margin-top: 2px;
  opacity: 0.6;
}
.dsh-suggest-text {
  min-width: 0;
}
/* Hover lights up the words themselves; the row stays transparent. The
   color-mix line is a slightly muted primary, so the lift stays soft. */
.dsh-suggest-chip:hover {
  color: var(--dsw-alias-label-primary, inherit);
  color: color-mix(in srgb, var(--dsw-alias-label-primary, #ffffff) 85%, transparent);
}
.dsh-suggest-chip:focus-visible {
  outline: none;
  color: var(--dsw-alias-label-primary, inherit);
  color: color-mix(in srgb, var(--dsw-alias-label-primary, #ffffff) 85%, transparent);
}
.dsh-suggest-chip:focus-visible .dsh-suggest-text {
  text-decoration: underline;
  text-underline-offset: 3px;
}
@media (pointer: coarse) {
  .dsh-suggest-chip { padding: 9px 12px; }
}
`

/** How long a clicked chip stays hidden while its send is in flight. */
const SEND_LOCK_MS = 3000

const EMPTY: readonly string[] = []

/**
 * The suggestions to surface, or an empty list when none should show.
 * @param suggestion - the stored suggestion set owned by this turn, or `null`.
 * @param running - whether the session agent is mid-turn.
 * @param draft - the current composer draft.
 * @param phase - the composer's submission phase.
 * @returns the chip texts to render.
 */
function visibleSuggestions(
  suggestion: SuggestPromptSuggestion | null,
  running: boolean,
  draft: string,
  phase: string | undefined,
): readonly string[] {
  if (running) return EMPTY
  if (suggestion === null) return EMPTY
  if (phase !== undefined && phase !== 'plain') return EMPTY
  if (draft.trim() !== '') return EMPTY
  return suggestion.suggestions
}

/**
 * Seat the tips in the newest completed turn's tail.
 * @param props - turn-tail owner props plus the session standard kit.
 */
export function SuggestionChips({ turn, useChat, useSession, useInput, inputActions, sessionId }: SuggestionChipsProps) {
  // Every completed turn has a tail; only the newest one may poll the store,
  // or a long history would keep one poller alive per row.
  const latestTurn = useChat(snapshot => snapshot.timeline.turnOrder.at(-1))
  if (latestTurn !== turn.turn) return null
  return (
    <TurnSuggestions
      turn={turn.turn}
      useSession={useSession}
      useInput={useInput}
      inputActions={inputActions}
      sessionId={sessionId}
    />
  )
}

type TurnSuggestionsProps = Pick<
  SuggestionChipsProps,
  'useSession' | 'useInput' | 'inputActions' | 'sessionId'
> & { turn: number }

/**
 * Render this turn's chip row; a click sends the prompt at once.
 * @param props - owning turn number plus the session standard kit.
 */
function TurnSuggestions({ turn, useSession, useInput, inputActions, sessionId }: TurnSuggestionsProps) {
  const stored = useStoredSuggestion(sessionId)
  // A tail must never borrow another turn's tips: the host keeps the old set
  // until the next turn ends, so without this check a history row could show
  // prompts that answer a different turn.
  const suggestion = stored !== null && stored.turn === turn ? stored : null
  const running = useSession(state => state.running)
  const draft = useInput(state => state.draft)
  const phase = useInput(state => state.phase)
  const [sending, setSending] = useState<string | null>(null)

  // A failed send (the submit was refused) must not hide the chips forever.
  useEffect(() => {
    if (sending === null) return
    const timer = setTimeout(() => { setSending(null) }, SEND_LOCK_MS)
    return () => { clearTimeout(timer) }
  }, [sending])

  // Inject the chip styles once for as long as this plugin is mounted.
  useEffect(() => {
    styleUsers += 1
    if (document.getElementById(STYLE_TAG_ID) === null) {
      const tag = document.createElement('style')
      tag.id = STYLE_TAG_ID
      tag.textContent = CSS_TEXT
      document.head.appendChild(tag)
    }
    return () => {
      styleUsers -= 1
      if (styleUsers !== 0) return
      document.getElementById(STYLE_TAG_ID)?.remove()
    }
  }, [])

  const visible = sending === null
    ? visibleSuggestions(suggestion, running, draft, phase)
    : EMPTY
  if (visible.length === 0) return null

  const send = (text: string): void => {
    if (sending !== null || running) return
    setSending(text)
    inputActions.setDraft(text)
    // The draft store is updated synchronously by setDraft; the microtask
    // keeps the submit on the next tick so the editor commit is complete.
    queueMicrotask(() => { inputActions.submit() })
  }

  return (
    <div className="dsh-suggest-chips" data-suggest-chips="">
      {visible.map(text => (
        <button
          key={text}
          type="button"
          className="dsh-suggest-chip"
          onMouseDown={event => { event.preventDefault() }}
          onClick={() => { send(text) }}
        >
          <svg
            className="dsh-suggest-arrow"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
            focusable="false"
          >
            <path
              d="M4.5 2.75v5.5a2 2 0 0 0 2 2h6M10.25 8.25 12.5 10.25l-2.25 2"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="dsh-suggest-text">{text}</span>
        </button>
      ))}
    </div>
  )
}
