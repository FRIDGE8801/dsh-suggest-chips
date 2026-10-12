/**
 * Package-owned durable suggest-prompt invariant.
 *
 * The plugin holds a session-log prohibition, and that prohibition is what this
 * companion now asserts: a suggestion never reaches the log. The pre-1.2 build
 * appended private `SessionEventMap` types, which are outside the harness's
 * closed `KNOWN_SESSION_EVENT_TYPES`; `0.2.0-rc.2` cannot mark an appended event
 * `ignorable`, so `validateStoredEvents` refused the whole log on the next cold
 * read and the session could not be reopened (issue #4). The suggestion is
 * persisted in this plugin's own storage domain instead (see ./records.ts), so
 * any `suggest-prompt`-shaped event appearing in a log is a regression, not
 * merely malformed data.
 * @module @studyzy/dsh-suggest-prompt/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@studyzy/dsh-suggest-prompt'

/**
 * The event-type prefixes this package must never write. Historical builds used
 * these; a current build writing one would break every reader sooner or later.
 */
const FORBIDDEN_PREFIXES = ['suggest-prompt/', 'plugin:suggest-prompt/'] as const

/** Cordis companion plugin name. */
export const name = 'suggest-prompt-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Reject any session event this package is forbidden to write.
 *
 * This is a hard prohibition rather than a payload check: the plugin's durable
 * channel is its storage domain, so a matching event means the log path was
 * reintroduced — the exact regression that made sessions unreadable.
 * @param event - the committed session event under inspection.
 * @param fail - invariant failure sink.
 */
export function validateEvent(event: SessionEvent, fail: InvariantFailure): void {
  const type = (event as { readonly type: string }).type
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (!type.startsWith(prefix)) continue
    fail(
      `suggest-prompt must not write session-log events (saw "${type}");`
      + ' suggestions are persisted in the plugin storage domain',
    )
    return
  }
}

/**
 * Install the log-prohibition check for newly committed events.
 *
 * Only committed delivery is validated, matching the `dsh >= 0.2.0` invariant
 * shape: the `internal/dispatch` tap sees every `session/event` (including the
 * replay of a resumed log), while scanning each Session's history with
 * `session.events` is prohibited for new production callers.
 */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [, event] = args as [Session, SessionEvent]
    validateEvent(event, fail)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the suggest-prompt invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))