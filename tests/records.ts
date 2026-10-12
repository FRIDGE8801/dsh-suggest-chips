/**
 * Test support for the plugin-record seam: the pinned rc.2 devDependency of
 * `@deepseek-ai/dsh-session` predates `appendPluginRecord`, so tests install
 * a stand-in writer that persists records through `session.append` — same
 * record name, same payload path, same `session/event` publication the
 * projection folds consume. The `ignorable` envelope marker itself is set by
 * the harness writer and cannot be reproduced through `session.append`; no
 * test asserts it.
 * @module tests/records
 */
import type { Session } from '@deepseek-ai/dsh-session'
import { SUGGEST_RECORD_TYPE, useRecordWriterForTests } from '../src/records.ts'
import type { RecordWriter } from '../src/records.ts'
import type { SuggestPromptSuggested } from '../src/types.ts'

// Test-only SessionEventMap member: `session.append` only accepts declared
// event types, and the stand-in writer persists through it. This merge is
// types-only and scoped to the test program; production code never appends.
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'plugin:suggest-prompt/suggested': SuggestPromptSuggested
  }
}

export { SUGGEST_RECORD_TYPE }

/**
 * Install the stand-in record writer. Pair with {@link restoreRecordWriter}
 * (a file-level `afterEach`); with no writer installed the plugin is
 * correctly dormant, which the disabled-path tests rely on.
 */
export function installTestRecordWriter(): void {
  const write: RecordWriter = (session, type, data) => session.append(type as never, data as never).seq
  useRecordWriterForTests(write)
}

/** Remove the stand-in writer, restoring the dormant (rc.2) default. */
export function restoreRecordWriter(): void {
  useRecordWriterForTests(undefined)
}

/** All suggestion records committed by `session`, in log order. */
export function suggestedRecords(session: Session): SuggestPromptSuggested[] {
  return session.snapshotEvents()
    .filter(event => (event as { type: string }).type === SUGGEST_RECORD_TYPE)
    .map(event => (event as { data: SuggestPromptSuggested }).data)
}
