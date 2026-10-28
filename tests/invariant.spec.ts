/**
 * suggest-chips invariant behavior: the companion enforces this package's
 * session-log prohibition — a suggestion is never written as a session event.
 *
 * That prohibition is the durable guarantee behind issue #4: private
 * `SessionEventMap` types are outside the harness's closed
 * `KNOWN_SESSION_EVENT_TYPES`, and `0.2.0-rc.2` cannot mark an appended event
 * `ignorable`, so one such event made the whole log unreadable on cold read. The
 * suggestion lives in this plugin's storage domain instead (see ./storage.ts),
 * so any matching event is a regression rather than merely bad data.
 *
 * `dsh >= 0.2.0` prohibits new synchronous reads of session history, so the
 * companion taps committed delivery instead of scanning `session.events` at
 * install time. Manual topology suites are excluded from the vitest-wide
 * invariant host (see scripts/test-invariants.ts).
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { apply as installCompanion } from '../src/invariant.ts'

/** The historical event type this package must never write again. */
const FORBIDDEN_TYPE = 'suggest-chips/suggested'
/** The plugin-record spelling a 1.2.x build used. */
const FORBIDDEN_PLUGIN_TYPE = 'plugin:suggest-chips/suggested'

/** Mount the invariant registry, session store, and this companion. */
async function mount(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(SessionStore)
  await ctx.plugin({ inject: ['invariants'], apply: installCompanion })
  return ctx
}

describe('suggest-chips invariant companion', () => {
  it('accepts ordinary session traffic', async () => {
    const ctx = await mount()
    const session = ctx.sessions.create(SessionId('ordinary'))
    expect(() => {
      session.append('turn/start', { turn: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    }).not.toThrow()
    await ctx.fiber.dispose()
  })

  it('rejects the private event type that broke cold reads', async () => {
    const ctx = await mount()
    const session = ctx.sessions.create(SessionId('forbidden'))
    expect(() => session.append(FORBIDDEN_TYPE as never, {
      version: 2, turn: 1, baseSeq: 2, suggestions: ['建议'],
    } as never)).toThrow(/must not write session-log events/)
    await ctx.fiber.dispose()
  })

  it('rejects the plugin-record spelling as well', async () => {
    const ctx = await mount()
    const session = ctx.sessions.create(SessionId('forbidden-plugin'))
    expect(() => session.append(FORBIDDEN_PLUGIN_TYPE as never, {
      version: 2, turn: 1, baseSeq: 2, suggestions: ['建议'],
    } as never)).toThrow(/must not write session-log events/)
    await ctx.fiber.dispose()
  })
})