/**
 * Browser-side suggestion source: reads the host's stored suggestion over the
 * plugin's own `connection.rpc` channel.
 *
 * The suggestion does NOT travel through a session projection. A projection can
 * only be advanced by a committed session event, and writing a plugin-private
 * event type is exactly what made sessions unreadable on cold read (issue #4) —
 * `0.2.0-rc.2` has no way to mark an appended event `ignorable`. So the host
 * keeps the suggestion in its own storage domain and serves it through
 * `ctx.connection.rpc.handle('/suggest-prompt', …)`, which is a public,
 * plugin-owned channel; nothing is written to the session log at all.
 *
 * `dsh-client-connection` is a type-only dependency here on purpose: the client
 * bundle's module whitelist (`PLATFORM_MODULES`) does not seed it, so it must
 * never appear in the emitted `require` set. This module only needs the
 * `ctx.connection` Context merge, which the type-only import supplies.
 *
 * Refresh is a bounded poll (see {@link POLL_INTERVAL_MS}). A turn completes on
 * the host asynchronously after the client's own `running` flag drops, so a
 * purely reactive read would show nothing; the interval is deliberately modest
 * because each poll is one cheap local loopback call, and polling stops as soon
 * as the component unmounts.
 * @module @studyzy/dsh-suggest-prompt/browser/suggestion-source
 */

import { useEffect, useState } from 'react'
import type { SuggestPromptSuggestion } from '../types.ts'
import { SUGGEST_RPC_CHANNEL, SUGGEST_RPC_GET } from '../rpc-contract.ts'

/**
 * The RPC face this plugin's browser half needs.
 *
 * Declared structurally rather than imported from `dsh-client-connection`: that
 * package is a type-only dependency (it is absent from the client bundle's
 * module whitelist), so this module keeps its own minimal view of the one
 * method it calls. The `ctx.connection` Context merge still comes from the
 * type-only import in the plugin entry.
 */
export interface SuggestPromptRpcFace {
  /** Generic RPC caller over a plugin-owned channel. */
  readonly connection: {
    readonly rpc: {
      call(
        channel: string,
        endpoint: string,
        payload: unknown,
        signal?: AbortSignal,
      ): Promise<{ readonly ok: boolean; readonly value?: unknown }>
    }
  }
}

/**
 * Poll interval for the stored suggestion, in milliseconds.
 *
 * The host write lands shortly after a turn completes; a sub-second poll keeps
 * the ghost text feeling immediate while costing one loopback request per
 * interval per mounted composer (the composer is a singleton per session).
 */
export const POLL_INTERVAL_MS = 700

/**
 * Read the stored suggestion for one session.
 *
 * Every failure mode returns `null` rather than throwing: this feeds ghost text
 * inside the composer, and a broken read must degrade to "no suggestion"
 * instead of surfacing an error where the user is typing.
 * @param ctx - client context carrying the connection service.
 * @param sessionId - session whose suggestion is read.
 * @param signal - abort signal for the request.
 * @returns the suggestion, or `null` when none is stored or the read failed.
 */
export async function fetchSuggestion(
  ctx: SuggestPromptRpcFace,
  sessionId: string,
  signal: AbortSignal,
): Promise<SuggestPromptSuggestion | null> {
  try {
    const result = await ctx.connection.rpc.call(
      SUGGEST_RPC_CHANNEL,
      SUGGEST_RPC_GET,
      { sessionId },
      signal,
    )
    if (!result.ok) {
      warnOnce(`suggest-prompt: read failed (${JSON.stringify((result as { error?: unknown }).error)})`)
      return null
    }
    const value = result.value
    return value === null || value === undefined ? null : value as SuggestPromptSuggestion
  } catch (error) {
    // An aborted request is the normal unmount path; a genuine transport
    // failure shows nothing rather than a broken composer. It is still
    // reported once: a silent catch here is indistinguishable from "no
    // suggestion yet", which makes a misconfigured channel undebuggable.
    warnOnce(`suggest-prompt: read threw ${String(error)}`)
    return null
  }
}

/** Whether the one-shot transport diagnostic has already been emitted. */
let warned = false

/**
 * Report a transport failure once per page.
 *
 * Rate-limited because the caller polls: an unreachable host would otherwise
 * write the same line every {@link POLL_INTERVAL_MS}.
 * @param message - the diagnostic to emit.
 */
function warnOnce(message: string): void {
  if (warned) return
  warned = true
  console.warn(message)
}

/**
 * Subscribe to the stored suggestion for one session, polling while mounted.
 *
 * The first read is immediate so a suggestion stored before this page loaded
 * (a reload, or a session reopened from history) reappears without waiting a
 * full interval.
 * @param ctx - client context carrying the connection service.
 * @param sessionId - session whose suggestion is tracked.
 * @returns the latest suggestion, or `null` while none is stored.
 */
export function useStoredSuggestion(
  ctx: SuggestPromptRpcFace,
  sessionId: string,
): SuggestPromptSuggestion | null {
  const [suggestion, setSuggestion] = useState<SuggestPromptSuggestion | null>(null)

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    const read = (): void => {
      void fetchSuggestion(ctx, sessionId, controller.signal).then((value) => {
        if (cancelled) return
        // Preserve the previous reference when the payload is unchanged so the
        // memoized accept-key matcher and the effect below do not churn on
        // every poll.
        setSuggestion(previous => (sameSuggestion(previous, value) ? previous : value))
      })
    }
    read()
    const timer = setInterval(read, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      controller.abort()
      clearInterval(timer)
    }
  }, [ctx, sessionId])

  return suggestion
}

/**
 * Whether two reads carry the same suggestion.
 *
 * Compared field-by-field rather than by deep equality: the payload is flat, so
 * this is both cheaper and total (no cycle or prototype concerns on data that
 * crossed the transport boundary).
 * @param left - previously displayed suggestion.
 * @param right - newly read suggestion.
 * @returns true when the two describe the same suggestion.
 */
function sameSuggestion(
  left: SuggestPromptSuggestion | null,
  right: SuggestPromptSuggestion | null,
): boolean {
  if (left === null || right === null) return left === right
  return left.turn === right.turn
    && left.baseSeq === right.baseSeq
    && left.text === right.text
    && left.truncated === right.truncated
    && left.acceptKey === right.acceptKey
    && left.route?.provider === right.route?.provider
    && left.route?.model === right.route?.model
}