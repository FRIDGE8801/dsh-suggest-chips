/**
 * The durable suggestion store: how a suggestion is persisted and reloaded
 * without ever touching the session log.
 *
 * Issue #4 history (why this is NOT a session event): the pre-1.2 build wrote
 * `suggest-prompt/request` and `suggest-prompt/suggested` through
 * `Session.append`. Those types are outside the harness's closed
 * `KNOWN_SESSION_EVENT_TYPES`, and `0.2.0-rc.2` offers no way to mark an
 * appended event `ignorable`, so `validateStoredEvents` refused the whole log
 * on the next cold read — every session that completed one suggestion became
 * unloadable. The 1.2.0 answer was an `appendPluginRecord` record, which
 * rc.2 does not have either; gating generation on that API's presence left
 * the feature permanently disabled on the shipped desktop app (a regression).
 *
 * This module takes the third path, and the one the plugin's own scope always
 * implied: a suggestion is plugin-owned derived state, so it belongs in the
 * plugin's own storage — not in the agent's conversation log at all. The
 * `domain` form of `ctx.storage` is mounted by `@deepseek-ai/dsh-base`, which
 * every profile composes, so this channel exists on rc.2 and on any future
 * harness, and it needs no harness change and no app repackaging. With zero
 * session-log writes, issue #4 cannot recur by construction.
 *
 * Records live one per session under the `suggest_prompt` domain
 * (`<dshHome>/storages/suggest_prompt/sessions/`), so a write rewrites one
 * session's document. The record is disposable derived data: an unreadable
 * record is backed up and skipped rather than failing the boot.
 * @module @studyzy/dsh-suggest-prompt/records
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SuggestPromptStorageRecord } from './domain.ts'
import type { SuggestPromptSuggestion } from './types.ts'

/** The stored-record name; also the domain's identity on the medium. */
export const SUGGEST_DOMAIN_NAME = 'suggest_prompt'

/** Validates one stored suggestion record at the durable boundary. */
const storedSuggestionSchema = z.object({
  version: z.literal(1),
  turn: z.number().int().positive(),
  baseSeq: z.number().int().nonnegative(),
  text: z.string().min(1),
  truncated: z.boolean(),
  acceptKey: z.string().min(1),
  route: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
  }).optional(),
}) as unknown as z.ZodType<SuggestPromptStorageRecord>

/**
 * The suggestion domain: one `sessions` table keyed by session id, each record
 * the complete latest suggestion (whole-value discipline — the record is
 * replaced, never patched). `per-record` layout keeps a write to one session's
 * document rather than the whole unit.
 *
 * `invalidRecords: 'backup-and-skip'`: a record that fails the schema is
 * disposable derived data, so it must never cost the boot — the domain layer
 * moves the document aside and serves the session with no stored suggestion.
 */
export const suggestPromptDomainSpec = defineDomain({
  name: SUGGEST_DOMAIN_NAME,
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: { sessions: domainTable<SessionId, SuggestPromptStorageRecord>(storedSuggestionSchema) },
})

/** The opened suggestion domain (its `sessions` table is the read/write face). */
export type SuggestPromptDomain = Domain<typeof suggestPromptDomainSpec>

/** One stored record, validated; the shape read back from the medium. */
export type StoredSuggestion = z.infer<typeof storedSuggestionSchema>

/**
 * The suggestion payload as persisted: the projection value plus the record
 * version. Deliberately not the projection type itself — a stored record is
 * owner-validated data whose schema is a durable contract.
 * @param suggestion - the generated suggestion.
 * @returns the record to store.
 */
export function toStoredRecord(suggestion: SuggestPromptSuggestion): SuggestPromptStorageRecord {
  return {
    version: 1,
    turn: suggestion.turn,
    baseSeq: suggestion.baseSeq,
    text: suggestion.text,
    truncated: suggestion.truncated,
    acceptKey: suggestion.acceptKey,
    ...(suggestion.route !== undefined ? { route: suggestion.route } : {}),
  }
}

/**
 * Project one stored record onto the wire value the client reads.
 * @param record - a validated stored record.
 * @returns the suggestion payload, or `undefined` when the record is unusable.
 */
export function toSuggestion(record: unknown): SuggestPromptSuggestion | undefined {
  const parsed = storedSuggestionSchema.safeParse(record)
  if (!parsed.success) return undefined
  const stored = parsed.data
  return {
    turn: stored.turn,
    baseSeq: stored.baseSeq,
    text: stored.text,
    truncated: stored.truncated,
    acceptKey: stored.acceptKey,
    ...(stored.route !== undefined ? { route: stored.route } : {}),
  }
}

/**
 * Read one session's stored suggestion.
 *
 * A record read back is validated before it is trusted: the harness leaves
 * record data to its owner, so an earlier build — or a hand edit — may have
 * written a shape this build does not accept.
 * @param domain - the opened suggestion domain.
 * @param sessionId - the session whose record is read.
 * @returns the stored suggestion, or `undefined` when none is usable.
 */
export function readSuggestion(
  domain: SuggestPromptDomain,
  sessionId: SessionId,
): SuggestPromptSuggestion | undefined {
  return toSuggestion(domain.table('sessions').get(sessionId))
}

/**
 * Persist one suggestion for a session, replacing any previous record.
 *
 * Awaited by the caller so a generation is durable before its in-flight slot
 * clears; a failed write surfaces as the generation's failure rather than
 * leaving the composer showing state the medium never accepted.
 * @param domain - the opened suggestion domain.
 * @param sessionId - the session whose suggestion is stored.
 * @param suggestion - the generated suggestion.
 */
export async function writeSuggestion(
  domain: SuggestPromptDomain,
  sessionId: SessionId,
  suggestion: SuggestPromptSuggestion,
): Promise<void> {
  await domain.table('sessions').put(sessionId, toStoredRecord(suggestion))
}

/**
 * Drop one session's stored suggestion.
 * @param domain - the opened suggestion domain.
 * @param sessionId - the session whose record is removed.
 * @returns whether a record was present.
 */
export async function clearSuggestion(
  domain: SuggestPromptDomain,
  sessionId: SessionId,
): Promise<boolean> {
  return await domain.table('sessions').delete(sessionId)
}