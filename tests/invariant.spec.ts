/**
 * suggest-prompt invariant behavior: the companion validates this package's
 * plugin record every time it is committed through `session/event`, which
 * covers both the live `appendPluginRecord` write and the replay of an
 * already-logged record.
 *
 * `dsh >= 0.2.0` prohibits new synchronous reads of session history, so the
 * companion no longer seeds by scanning `session.events` at install time; it
 * relies on committed delivery instead. These tests therefore exercise the
 * delivery tap (accepting a valid record, rejecting a malformed one) rather
 * than an install-time scan. The `ignorable` envelope marker is set by the
 * harness writer and is not this package's invariant to check.
 * Manual topology suites are excluded from the vitest-wide invariant host
 * (see scripts/test-invariants.ts).
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { apply as installCompanion } from '../src/invariant.ts'
import { SUGGEST_RECORD_TYPE } from './records.ts'

describe('suggest-prompt invariant companion', () => {
  it('accepts a well-formed suggestion record committed after install', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(SessionStore)
    await ctx.plugin({ inject: ['invariants'], apply: installCompanion })
    const session = ctx.sessions.create(SessionId('valid-delivery'))
    session.append('turn/start', { turn: 1 })
    // A valid payload must pass the delivery tap without failing the invariant.
    expect(() => session.append(SUGGEST_RECORD_TYPE, {
      version: 1, turn: 1, baseSeq: 2, text: '建议', truncated: false, acceptKey: 'Tab',
    })).not.toThrow()
    await ctx.fiber.dispose()
  })

  it('rejects a malformed record appended after install', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(SessionStore)
    await ctx.plugin({ inject: ['invariants'], apply: installCompanion })
    const session = ctx.sessions.create(SessionId('post-install'))
    expect(() => session.append(SUGGEST_RECORD_TYPE, {
      version: 1, turn: 1, baseSeq: 'x', text: '', truncated: 'y', acceptKey: 'Tab',
    } as never)).toThrow(/invalid suggestion payload/)
    await ctx.fiber.dispose()
  })
})
