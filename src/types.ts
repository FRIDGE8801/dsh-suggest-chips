/**
 * Pure types of the suggest-chips domain: the shared suggestion payload and
 * the host-only transcript fold state, free of this package's host-side imports
 * (cordis events, dsh-llm, the plugin). The deployment {@link Config} lives on
 * the plugin itself (`src/index.ts`) because the config catalog pastes
 * declarations verbatim. Both runtime halves read these through one outlet —
 * `./types` for host consumers, `./client` (the browser half-entry re-exports
 * these) for client aggregates — with zero content duplication. Host-coupled
 * vocabulary (storage record, message sources) lives in ./domain.ts.
 *
 * The suggestion is NOT a session projection. A projection advances only on a
 * committed session event, and a plugin-private event type is what made
 * sessions unreadable on cold read (issue #4); the value travels over this
 * plugin's own `connection.rpc` channel instead (see ./records.ts).
 *
 * @module dsh-suggest-chips/types
 */

/** The suggestions generated after one completed turn, whole-value per record. */
export interface SuggestPromptSuggestion {
  /** Completed turn whose completion this suggestion answers. */
  readonly turn: number
  /** Seq of the last model-visible message the transcript was built from. */
  readonly baseSeq: number
  /** Sanitized single-line candidate next prompts, best first. */
  readonly suggestions: readonly string[]
  /** Exact auxiliary LLM route. */
  readonly route?: { readonly provider: string; readonly model: string }
}

/**
 * The value the browser read endpoint returns: the latest stored suggestion for
 * one session, or `null` before the first suggestion. The client chip row
 * reads this; stale suggestions are matched against the session's latest
 * completed turn by `turn`.
 */
export type SuggestPromptProjection = SuggestPromptSuggestion | null

/**
 * One model-visible user/assistant exchange retained for the suggestion
 * transcript, with the log attribution needed to bound and cite it.
 */
export interface SuggestPromptTranscriptEntry {
  /** Log seq of the source `user/message` or `assistant/message` event. */
  readonly seq: number
  /** Speaker of the retained message. */
  readonly role: 'user' | 'assistant'
  /** Rendered, redacted, single-line text. */
  readonly text: string
  /** Turn this message belongs to (`0` before the first `turn/start`). */
  readonly turn: number
}

/**
 * Host-only fold state backing the suggestion transcript. `dsh >= 0.2.0`
 * deprecates synchronous session-history reads for new production callers, so
 * the plugin reconstructs what it needs from committed events instead of
 * scanning `session.events`: `turnStarts` bounds the completed-turn window,
 * `entries` carries the model-visible text, and `lastSuggestedTurn` seeds the
 * per-session dedupe cursor across reloads.
 */
export interface SuggestPromptTranscriptState {
  /** Turn number of the newest `turn/end` seen, or `0` before any completes. */
  readonly lastCompletedTurn: number
  /** Turn-start seq per turn, oldest first (bounds the transcript window). */
  readonly turnStarts: readonly { readonly turn: number; readonly seq: number }[]
  /** Retained model-visible pairs, oldest first, bounded by a fixed window. */
  readonly entries: readonly SuggestPromptTranscriptEntry[]
  /** Newest suggestion record turn, or `-1`; the dedupe cursor. */
  readonly lastSuggestedTurn: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /**
     * Host-only transcript fold. Never client-visible: the retained text is
     * consumed on the host to build the bounded auxiliary request.
     */
    suggestPromptTranscript: SuggestPromptTranscriptState
  }
}
