/** Package-owned durable suggest-prompt invariants. @module @studyzy/dsh-suggest-prompt/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { SUGGEST_RECORD_TYPE, isValidSuggestedPayload } from './records.ts'

const PACKAGE_NAME = '@studyzy/dsh-suggest-prompt'

/** Cordis companion plugin name. */
export const name = 'suggest-prompt-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Validate one suggest-prompt plugin record payload before it reaches the
 * durable log. Only this package's record type is checked; the `ignorable`
 * marker itself is guaranteed by the harness's `appendPluginRecord`, not by
 * this package's code.
 */
function validateEvent(event: SessionEvent, fail: InvariantFailure): void {
  if ((event as { readonly type: string }).type !== SUGGEST_RECORD_TYPE) return
  const data = (event as { readonly data: unknown }).data
  if (!isValidSuggestedPayload(data)) {
    fail('plugin:suggest-prompt/suggested carries an invalid suggestion payload')
  }
}

/**
 * Install validation for newly committed suggest-prompt state.
 *
 * Only committed delivery is validated, matching the `dsh >= 0.2.0` invariant
 * shape: the `internal/dispatch` tap sees every `session/event` (including
 * plugin records, which share the ordinary commit path, and the replay of a
 * resumed log), while scanning each Session's history with `session.events`
 * is prohibited for new production callers.
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
