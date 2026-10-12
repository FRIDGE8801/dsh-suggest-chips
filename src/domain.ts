/**
 * Host-side vocabulary of the suggest-prompt domain: the durable plugin-record
 * payload and the session message-source merge. Kept separate from ./types.ts
 * (the pure client-safe outlet) because these declarations pull dsh-llm into
 * the program — the one-program-per-side layout forbids that on client
 * aggregates.
 *
 * The suggestion is persisted through `appendPluginRecord` under
 * `plugin:suggest-prompt/suggested` (see ./records.ts) — NOT as a
 * `SessionEventMap` event: private event types wedged sessions on harnesses
 * that cannot mark them ignorable (issue #4).
 * @module @studyzy/dsh-suggest-prompt
 */

import type { SuggestPromptSuggestion } from './types.ts'

/** Whole-value post-success suggestion recorded as one ignorable plugin record. */
export interface SuggestPromptSuggested extends SuggestPromptSuggestion {
  /** Format version of the payload. */
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
