/**
 * The plugin-record seam: how a suggestion reaches the session log without
 * making that log unreadable.
 *
 * Issue #4: private `SessionEventMap` types written through `Session.append`
 * are outside the harness's closed `KNOWN_SESSION_EVENT_TYPES`, and rc.2 has
 * no way to mark an appended event `ignorable` — so every suggestion wedged
 * the session on the next cold read. The harness answered with
 * `appendPluginRecord` (dsh >= 0.2.1): the record enters the log already
 * marked `ignorable: true`, unknown readers retain and skip it, it never
 * joins the model-visible surface, and it still publishes `session/event`
 * — which is exactly what the projection folds consume. A record holds
 * plugin-owned state its owner can lose without changing how the rest of the
 * log is interpreted.
 *
 * On a harness without that writer (0.2.0-rc.2) the plugin must not generate
 * at all: an LLM call whose only delivery channel is a log write that wedges
 * the session. `canAppendRecords()` is the gate.
 *
 * The writer is resolved structurally (namespace import + property probe)
 * instead of a named import because a named ESM import of an export the
 * running harness does not have fails at module link — the plugin would die
 * at load on exactly the harnesses it must stay quiet on. The pinned rc.2
 * devDependency predates the API, so all record typing here is structural.
 * @module @studyzy/dsh-suggest-prompt/records
 */

import * as dshSession from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SuggestPromptSuggested } from './domain.ts'

/**
 * This package's record name. Grammar per the harness `PluginRecordType`:
 * `plugin:` followed by slash-separated lowercase segments.
 */
export const SUGGEST_RECORD_TYPE = 'plugin:suggest-prompt/suggested'

/** Structural face of the harness's `appendPluginRecord` (dsh >= 0.2.1). */
export type RecordWriter = (session: Session, type: string, data: unknown) => number

let recordWriter: RecordWriter | undefined =
  (dshSession as { appendPluginRecord?: RecordWriter }).appendPluginRecord

/**
 * Whether the running harness can persist ignorable plugin records. False on
 * 0.2.0-rc.2 and older, where the plugin must stay fully dormant (no LLM
 * call, no log write — issue #4).
 */
export const canAppendRecords = (): boolean => recordWriter !== undefined

/**
 * Substitute the record writer. Test-only seam: the pinned devDependency
 * predates `appendPluginRecord`, so unit tests install a stand-in that
 * exercises the same type string and payload path. Tests must restore
 * `undefined` afterwards — with no writer the plugin is correctly dormant.
 * @param writer - the substitute writer, or `undefined` to simulate a
 *   harness without the record API.
 */
export function useRecordWriterForTests(writer: RecordWriter | undefined): void {
  recordWriter = writer
}

/**
 * Persist one suggestion as a single ignorable plugin record.
 * @param session - session whose log receives the record.
 * @param data - the sanitized whole-value suggestion payload.
 * @throws when the running harness has no record writer — the caller above
 *   (`apply`) gates on {@link canAppendRecords} first, so this only fires on
 *   a policy violation.
 */
export function appendSuggestedRecord(session: Session, data: SuggestPromptSuggested): void {
  if (recordWriter === undefined) {
    throw new Error('suggest-prompt: the running harness cannot persist plugin records (needs dsh >= 0.2.1)')
  }
  recordWriter(session, SUGGEST_RECORD_TYPE, data)
}

/**
 * The suggestion payload of a committed plugin record, or `undefined` for any
 * other event. The payload is NOT validated here — a restored record carries
 * whatever JSON an earlier build of this package wrote (the harness leaves
 * record data to its owner), so consumers pass it through
 * {@link isValidSuggestedPayload} before trusting it.
 * @param event - any committed session event.
 */
export function suggestedRecordOf(event: SessionEvent): SuggestPromptSuggested | undefined {
  if ((event as { readonly type: string }).type !== SUGGEST_RECORD_TYPE) return undefined
  return (event as { readonly data: unknown }).data as SuggestPromptSuggested
}

/** One non-empty provider/model pair. */
function isSuggestedRoute(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record['provider'] === 'string' && record['provider'].length > 0
    && typeof record['model'] === 'string' && record['model'].length > 0
}

/**
 * Validate a record payload read back from the log. The write side
 * (`invariant.ts`) enforces the same shape at commit; this read-side check
 * exists because a stored record is owner-validated data that may have been
 * written by any earlier build.
 * @param data - untrusted record payload.
 * @returns whether the payload is a well-formed `SuggestPromptSuggested`.
 */
export function isValidSuggestedPayload(data: unknown): data is SuggestPromptSuggested {
  if (typeof data !== 'object' || data === null) return false
  const record = data as Record<string, unknown>
  return record['version'] === 1
    && typeof record['turn'] === 'number' && Number.isSafeInteger(record['turn']) && record['turn'] > 0
    && typeof record['baseSeq'] === 'number' && Number.isSafeInteger(record['baseSeq']) && record['baseSeq'] >= 0
    && typeof record['text'] === 'string' && record['text'].length > 0
    && typeof record['truncated'] === 'boolean'
    && typeof record['acceptKey'] === 'string' && record['acceptKey'].length > 0
    && (record['route'] === undefined || isSuggestedRoute(record['route']))
}
