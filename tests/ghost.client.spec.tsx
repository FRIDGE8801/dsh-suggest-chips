// @vitest-environment jsdom
/**
 * Ghost suggestion bridge behavior. The suggestion no longer arrives through a
 * session projection (a projection only advances on a committed session event,
 * and a plugin-private event type is what made sessions unreadable — issue #4):
 * it is read from the host's storage domain over the plugin's own
 * `connection.rpc` channel. The component therefore takes an extra `face` prop,
 * and the tests drive a fake RPC face whose `call()` answers with
 * `{ ok: true, value: <suggestion|null> }`.
 *
 * The source polls (`suggestion-source.ts`, `POLL_INTERVAL_MS = 700`), so every
 * assertion that depends on a read has to let the first, immediate read settle —
 * `await waitFor` covers that without fake timers, and the poll timer is
 * cleared on unmount so no test can hang.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import type { ConversationSnapshot, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { GhostSuggestion } from '../src/browser/GhostSuggestion.tsx'
import type { GhostSuggestionProps } from '../src/browser/GhostSuggestion.tsx'
import { POLL_INTERVAL_MS } from '../src/browser/suggestion-source.ts'
import { SUGGEST_ROUTE_METHOD, SUGGEST_ROUTE_PATH } from '../src/rpc-contract.ts'
import type { SuggestPromptSuggestion } from '../src/types.ts'

afterEach(cleanup)

const SID = 's1' as SessionId

const SUGGESTION: SuggestPromptSuggestion = {
  turn: 3,
  baseSeq: 40,
  text: '继续修复登录页',
  truncated: false,
  acceptKey: 'Tab',
}

/** One recorded call into the plugin's fetch route. */
interface Call {
  readonly path: string
  readonly method: string
  readonly payload: unknown
}

/**
 * Stub the plugin's own `/api` route and record what the component asked for.
 *
 * The browser half deliberately uses a plain `fetch` rather than an RPC client:
 * the host cannot register an `rpc.handle` channel at all (that surface reads
 * `webServer` on the connection service's own fiber, which never injects it), so
 * there is no face object to fake here.
 */
function fakeFetch(answer: { value?: unknown; status?: number; reject?: Error } = {}) {
  const calls: Call[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      path: String(input),
      method: init?.method ?? 'GET',
      payload: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    })
    if (answer.reject !== undefined) throw answer.reject
    const status = answer.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ suggestion: answer.value ?? null }),
    } as unknown as Response
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

function kit(over: {
  running?: boolean
  draft?: string
  suggestion?: SuggestPromptSuggestion | null
  answer?: { value?: unknown; status?: number; reject?: Error }
} = {}) {
  const setDraft = vi.fn()
  const session = { running: over.running ?? false }
  const net = fakeFetch(over.answer ?? { value: over.suggestion ?? null })
  const props = {
    sessionId: SID,
    useSession: (selector: (s: ConversationSnapshot) => unknown) => selector(session as ConversationSnapshot),
    useInput: (selector: (s: { draft: string }) => unknown) => selector({ draft: over.draft ?? '' }),
    inputActions: { setDraft },
  } as unknown as GhostSuggestionProps
  return { setDraft, props, calls: net.calls, restore: net.restore }
}

/** The rendered ghost layer element, or null when no ghost shows. */
function ghostLayer(): HTMLElement | null {
  return document.querySelector('[data-suggest-prompt-ghost]')
}

/** The visible ghost text content, or '' when no ghost shows. */
function ghostText(): string {
  return ghostLayer()?.textContent ?? ''
}

/** Focus a throwaway textarea and return it (removed by the caller's cleanup). */
function focusedTextarea(): HTMLTextAreaElement {
  const textarea = document.createElement('textarea')
  document.body.appendChild(textarea)
  textarea.focus()
  return textarea
}

/**
 * Build the `dsh >= 0.2.0` composer shape and focus its editable host: a
 * `[data-input-scroll]` layer wrapping a Lexical `contenteditable` div. The
 * composer is no longer a `<textarea>`, which is exactly what the accept path
 * must tolerate.
 * @returns the focused contenteditable host element.
 */
function focusedContentEditable(): HTMLElement {
  const scroll = document.createElement('div')
  scroll.setAttribute('data-input-scroll', '')
  const host = document.createElement('div')
  host.setAttribute('contenteditable', 'true')
  host.tabIndex = 0
  scroll.appendChild(host)
  document.body.appendChild(scroll)
  host.focus()
  return host
}

/** Dispatch a keydown on the window and return the (cancelable) event. */
function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  window.dispatchEvent(event)
  return event
}

/**
 * Render and wait for the first (immediate) RPC read to land.
 * @param props - the component props under test.
 * @returns the testing-library render result.
 */
async function renderGhost(props: GhostSuggestionProps) {
  const view = render(<GhostSuggestion {...props} />)
  // One settling pass: the source's first read is issued from an effect and
  // resolves on a microtask, so nothing renders on the very first paint.
  await act(async () => { await Promise.resolve() })
  return view
}

describe('GhostSuggestion bridge', () => {
  it('renders the suggestion when it answers the latest completed turn on an idle empty draft', async () => {
    const { props } = kit({ suggestion: SUGGESTION })
    await renderGhost(props)
    await waitFor(() => { expect(ghostText()).toBe('继续修复登录页') })
  })

  it('reads the suggestion from the plugin-owned route for its own session', async () => {
    const { props, calls } = kit({ suggestion: SUGGESTION })
    await renderGhost(props)
    await waitFor(() => { expect(calls.length).toBeGreaterThan(0) })
    expect(calls[0]).toEqual({
      path: SUGGEST_ROUTE_PATH,
      method: SUGGEST_ROUTE_METHOD,
      payload: { sessionId: SID },
    })
    // The path must sit under `/api`: `assertFetchRoute` rejects anything else,
    // and the shared gateway only dispatches exact paths it has registered.
    expect(SUGGEST_ROUTE_PATH).toBe('/api/suggest-prompt')
    expect(SUGGEST_ROUTE_PATH.startsWith('/api/')).toBe(true)
    expect(SUGGEST_ROUTE_METHOD).toBe('POST')
  })

  it('renders nothing while the agent is running', async () => {
    const { props } = kit({ suggestion: SUGGESTION, running: true })
    await renderGhost(props)
    expect(ghostLayer()).toBeNull()
  })

  it('renders nothing while the draft has text', async () => {
    const { props } = kit({ suggestion: SUGGESTION, draft: '在输入' })
    await renderGhost(props)
    expect(ghostLayer()).toBeNull()
  })

  it('renders nothing once a new turn starts, so stale text never outlives its turn', async () => {
    // rc.2 removed the client's `turnEnds` map, so freshness is derived from the
    // running flag: a suggestion is current only while the agent is idle.
    const { props } = kit({ suggestion: SUGGESTION, running: true })
    await renderGhost(props)
    expect(ghostLayer()).toBeNull()
  })

  it('re-shows the persisted suggestion when the draft is cleared again', async () => {
    const { props } = kit({ suggestion: SUGGESTION, draft: '在输入' })
    const view = await renderGhost(props)
    expect(ghostLayer()).toBeNull()
    const { props: cleared } = kit({ suggestion: SUGGESTION })
    await act(async () => { view.rerender(<GhostSuggestion {...cleared} />) })
    await waitFor(() => { expect(ghostText()).toBe('继续修复登录页') })
  })

  it('renders nothing before the first suggestion or when nothing is stored', async () => {
    for (const suggestion of [null, undefined]) {
      const { props } = kit({ suggestion })
      await renderGhost(props)
      expect(ghostLayer()).toBeNull()
      cleanup()
    }
  })

  it('degrades to no suggestion when the read fails', async () => {
    // A broken read must not surface an error where the user is typing.
    const { props } = kit({ answer: { reject: new Error('transport is down') } })
    await renderGhost(props)
    expect(ghostLayer()).toBeNull()
  })

  it('degrades to no suggestion when the endpoint reports failure', async () => {
    const { props } = kit({ answer: { status: 500 } })
    await renderGhost(props)
    expect(ghostLayer()).toBeNull()
  })

  it('polls for a suggestion that lands after mount', async () => {
    vi.useFakeTimers()
    try {
      // Install the stub AFTER `kit()`: the kit builds its own fetch stub, so
      // stubbing first would be overwritten and the poll would never see the
      // value change.
      const { props } = kit()
      let stored: unknown = null
      const original = globalThis.fetch
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ suggestion: stored }),
      }) as unknown as Response) as typeof fetch
      render(<GhostSuggestion {...props} />)
      await act(async () => { await Promise.resolve() })
      expect(ghostLayer()).toBeNull()

      // The host writes the suggestion after the turn settles, which is after
      // this component mounted — the bounded poll is what surfaces it.
      stored = SUGGESTION
      // Two ticks: the first fires the poll, and flushing its resolved promise
      // (which the component's `.then` awaits) is what re-renders with the text.
      await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS) })
      await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS) })
      expect(ghostText()).toBe('继续修复登录页')
      globalThis.fetch = original
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops polling once unmounted', async () => {
    vi.useFakeTimers()
    try {
      const { props, calls } = kit({ suggestion: SUGGESTION })
      const view = render(<GhostSuggestion {...props} />)
      await act(async () => { await Promise.resolve() })
      const afterMount = calls.length
      await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS) })
      expect(calls.length).toBeGreaterThan(afterMount)
      const beforeUnmount = calls.length
      view.unmount()
      await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3) })
      expect(calls).toHaveLength(beforeUnmount)
    } finally {
      vi.useRealTimers()
    }
  })

  it('Tab fills the draft with the suggestion while the composer textarea holds focus', async () => {
    const { setDraft, props } = kit({ suggestion: SUGGESTION })
    await renderGhost(props)
    await waitFor(() => { expect(ghostText()).toBe('继续修复登录页') })
    const textarea = focusedTextarea()
    let event: KeyboardEvent | undefined
    act(() => {
      event = press({ key: 'Tab', code: 'Tab' })
    })
    expect(event?.defaultPrevented).toBe(true)
    expect(setDraft).toHaveBeenCalledWith('继续修复登录页')
    textarea.remove()
  })

  it('Tab is ignored when the composer textarea does not hold focus', async () => {
    const { setDraft, props } = kit({ suggestion: SUGGESTION })
    await renderGhost(props)
    await waitFor(() => { expect(ghostText()).toBe('继续修复登录页') })
    const event = press({ key: 'Tab', code: 'Tab' })
    expect(event.defaultPrevented).toBe(false)
    expect(setDraft).not.toHaveBeenCalled()
  })

  it('Tab with a modifier is not the accept shortcut', async () => {
    const { setDraft, props } = kit({ suggestion: SUGGESTION })
    await renderGhost(props)
    await waitFor(() => { expect(ghostText()).toBe('继续修复登录页') })
    const textarea = focusedTextarea()
    act(() => {
      press({ key: 'Tab', code: 'Tab', shiftKey: true })
    })
    expect(setDraft).not.toHaveBeenCalled()
    textarea.remove()
  })

  it('an IME composition keydown never accepts the suggestion', async () => {
    const { setDraft, props } = kit({ suggestion: SUGGESTION })
    await renderGhost(props)
    await waitFor(() => { expect(ghostText()).toBe('继续修复登录页') })
    const textarea = focusedTextarea()
    act(() => {
      press({ key: 'Tab', code: 'Tab', isComposing: true })
    })
    expect(setDraft).not.toHaveBeenCalled()
    textarea.remove()
  })

  it('Tab is ignored when there is no suggestion to accept', async () => {
    const { setDraft, props } = kit({ suggestion: null })
    await renderGhost(props)
    const textarea = focusedTextarea()
    const event = press({ key: 'Tab', code: 'Tab' })
    expect(event.defaultPrevented).toBe(false)
    expect(setDraft).not.toHaveBeenCalled()
    textarea.remove()
  })

  it('a configured custom shortcut fills the draft instead of Tab', async () => {
    const { setDraft, props } = kit({ suggestion: { ...SUGGESTION, acceptKey: 'Alt+Slash' } })
    await renderGhost(props)
    await waitFor(() => { expect(ghostText()).toBe('继续修复登录页') })
    const textarea = focusedTextarea()
    act(() => {
      press({ key: '/', code: 'Slash', altKey: true })
    })
    expect(setDraft).toHaveBeenCalledWith('继续修复登录页')
    act(() => {
      press({ key: 'Tab', code: 'Tab' })
    })
    expect(setDraft).toHaveBeenCalledTimes(1)
    textarea.remove()
  })

  // `dsh >= 0.2.0` replaced the composer `<textarea>` with a Lexical
  // `contenteditable` host. An `instanceof HTMLTextAreaElement` focus test made
  // Tab silently do nothing on a current build, so both shapes must accept.
  it('Tab fills the draft when the contenteditable composer host holds focus', async () => {
    const { setDraft, props } = kit({ suggestion: SUGGESTION })
    await renderGhost(props)
    await waitFor(() => { expect(ghostText()).toBe('继续修复登录页') })
    const host = focusedContentEditable()
    let event: KeyboardEvent | undefined
    act(() => {
      event = press({ key: 'Tab', code: 'Tab' })
    })
    expect(event?.defaultPrevented).toBe(true)
    expect(setDraft).toHaveBeenCalledWith('继续修复登录页')
    host.parentElement?.remove()
  })

  it('Tab is ignored when focus sits outside the composer', async () => {
    const { setDraft, props } = kit({ suggestion: SUGGESTION })
    await renderGhost(props)
    await waitFor(() => { expect(ghostText()).toBe('继续修复登录页') })
    // A plain focusable element that is not part of the composer editor.
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()
    const event = press({ key: 'Tab', code: 'Tab' })
    expect(event.defaultPrevented).toBe(false)
    expect(setDraft).not.toHaveBeenCalled()
    outside.remove()
  })

  it('a malformed configured shortcut falls back to the default Tab', async () => {
    const { setDraft, props } = kit({ suggestion: { ...SUGGESTION, acceptKey: 'Bogus+Key' } })
    await renderGhost(props)
    await waitFor(() => { expect(ghostText()).toBe('继续修复登录页') })
    const textarea = focusedTextarea()
    act(() => {
      press({ key: 'Tab', code: 'Tab' })
    })
    expect(setDraft).toHaveBeenCalledWith('继续修复登录页')
    textarea.remove()
  })

  it('unconfigured keys never fill the draft', async () => {
    const { setDraft, props } = kit({ suggestion: SUGGESTION })
    await renderGhost(props)
    await waitFor(() => { expect(ghostText()).toBe('继续修复登录页') })
    const textarea = focusedTextarea()
    act(() => {
      press({ key: 'Enter', code: 'Enter' })
    })
    expect(setDraft).not.toHaveBeenCalled()
    textarea.remove()
  })
})

describe('GhostSuggestion placeholder handling', () => {
  /** The injected style tag's text, or '' when the plugin is not mounted. */
  function injectedCss(): string {
    return document.getElementById('dsh-suggest-prompt-style')?.textContent ?? ''
  }

  it('hides the native placeholder element while a ghost is visible', async () => {
    const { props } = kit({ suggestion: SUGGESTION })
    await renderGhost(props)
    const css = injectedCss()
    // `dsh >= 0.2.0` renders the composer placeholder as a real element
    // ([data-composer-placeholder]); the old textarea pseudo-element rule is
    // kept only as a fallback for older assemblies.
    expect(css).toContain('[data-composer-placeholder]')
    expect(css).toContain('[data-composer-card]:has(.dsh-suggest-prompt-ghost)')
    // Hiding must preserve the box (an absolutely positioned sibling) so the
    // composer height does not jump when a suggestion appears or is accepted.
    expect(css).toMatch(/\[data-composer-placeholder\]\s*\{\s*visibility:\s*hidden/)
  })

  it('removes the style tag once the last ghost unmounts', async () => {
    const { props } = kit({ suggestion: SUGGESTION })
    await renderGhost(props)
    expect(injectedCss()).not.toBe('')
    cleanup()
    expect(document.getElementById('dsh-suggest-prompt-style')).toBeNull()
  })
})