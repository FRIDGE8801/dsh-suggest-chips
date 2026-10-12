/**
 * Host-side vocabulary of the suggest-prompt domain: the durable storage
 * record and the session message-source merge. Kept separate from ./types.ts
 * (the pure client-safe outlet) because these declarations pull dsh-llm into
 * the program — the one-program-per-side layout forbids that on client
 * aggregates.
 *
 * The suggestion is persisted in this plugin's own storage domain (see
 * ./records.ts) — NOT as a session-log write of any kind. The pre-1.2 build
 * appended private `SessionEventMap` types, which wedged sessions on harnesses
 * that cannot mark an appended event ignorable (issue #4); a suggestion is
 * plugin-owned derived state and needs no place in the agent's log.
 * @module @studyzy/dsh-suggest-prompt
 */

import type { SuggestPromptSuggestion } from './types.ts'

/**
 * Whole-value durable record of the latest suggestion for one session. This is
 * the storage-domain record schema's type: a durable contract, deliberately
 * separate from the projection value the client reads.
 */
export interface SuggestPromptStorageRecord extends SuggestPromptSuggestion {
  /** Format version of the stored record. */
  readonly version: 1
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Programmatic input from this capability's own bounded auxiliary call.
     * `dsh >= 0.2.0` removed the shared catch-all `plugin` source kind: the
     * union is merge-extensible and each producer declares its own kind, so
     * this plugin names itself.
     */
    'suggest-prompt': {
      readonly kind: 'suggest-prompt'
      /** Plugin package that produced the message. */
      readonly plugin: string
      /** Which part of the auxiliary exchange this message carries. */
      readonly form: 'transcript'
    }
  }
}