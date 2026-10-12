/**
 * The two seams that replaced the session-log record: the durable suggestion
 * store, and the browser read endpoint over `connection.rpc`.
 *
 * These are the contracts issue #4 turned on: a suggestion must be persisted
 * somewhere that is NOT the session log, and it must still reach the composer.
 * The store tests cover the read/write/ownership rules; the endpoint tests cover
 * the browser-visible half, including the malformed and unknown-endpoint paths
 * that decide whether a broken call degrades to "no ghost text" or breaks the
 * composer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createAssistantMessage, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import { apply as applyPlugin, Config as PluginConfig, inject as PLUGIN_INJECT } from '../src/index.ts'
import {
  readSuggestion,
  toStoredRecord,
  toSuggestion,
  writeSuggestion,
  suggestPromptDomainSpec,
  SUGGEST_DOMAIN_NAME,
} from '../src/records.ts'
import { SUGGEST_RPC_CHANNEL, SUGGEST_RPC_GET } from '../src/rpc-contract.ts'
import { createFakeDomain, installFakeStorage } from './storage.ts'
import type { FakeStorageDomain } from './storage.ts'

const SUGGESTION = {
  turn: 1,
  baseSeq: 4,
  text: 'run the focused suite',
  truncated: false,
  acceptKey: 'Tab',
} as const

const CONFIG = {
  maxInputBytes: 4096,
  maxOutputTokens: 512,
  timeoutMs: 60_000,
  maxRecentTurns: 1,
  maxTranscriptChars: 12_000,
  maxSuggestionChars: 240,
  acceptKey: 'Tab',
}

describe('the durable suggestion store', () => {
  it('declares one per-record domain that never fails the boot on bad data', () => {
    // The spec IS the durable contract: a rename or version bump silently
    // orphans every stored suggestion, and dropping `invalidRecords` would turn
    // one unreadable record into a failed startup.
    expect(SUGGEST_DOMAIN_NAME).toBe('suggest_prompt')
    expect(suggestPromptDomainSpec.name).toBe('suggest_prompt')
    expect(suggestPromptDomainSpec.version).toBe(1)
    expect(suggestPromptDomainSpec.invalidRecords).toBe('backup-and-skip')
    expect(Object.keys(suggestPromptDomainSpec.tables)).toEqual(['sessions'])
  })

  it('round-trips a suggestion through the store', async () => {
    const domain = createFakeDomain()
    await writeSuggestion(domain as never, SessionId('s1'), SUGGESTION)
    expect(readSuggestion(domain as never, SessionId('s1'))).toEqual(SUGGESTION)
  })

  it('returns undefined for a session with no stored suggestion', () => {
    const domain = createFakeDomain()
    expect(readSuggestion(domain as never, SessionId('absent'))).toBeUndefined()
  })

  it('replaces the whole record rather than merging (whole-value discipline)', async () => {
    const domain = createFakeDomain()
    await writeSuggestion(domain as never, SessionId('s1'), SUGGESTION)
    await writeSuggestion(domain as never, SessionId('s1'), {
      ...SUGGESTION, turn: 2, text: 'second', truncated: true,
    })
    expect(domain.records.size).toBe(1)
    expect(readSuggestion(domain as never, SessionId('s1'))).toMatchObject({ turn: 2, text: 'second', truncated: true })
  })

  it('keeps one record per session', async () => {
    const domain = createFakeDomain()
    await writeSuggestion(domain as never, SessionId('a'), SUGGESTION)
    await writeSuggestion(domain as never, SessionId('b'), { ...SUGGESTION, text: 'other' })
    expect(domain.records.size).toBe(2)
    expect(readSuggestion(domain as never, SessionId('a'))?.text).toBe('run the focused suite')
    expect(readSuggestion(domain as never, SessionId('b'))?.text).toBe('other')
  })

  it('refuses to serve a record written by another build', () => {
    // A record is owner-validated data: the harness leaves its shape to the
    // plugin, so a stale or hand-edited row must read as "no suggestion" rather
    // than reach the composer as a malformed value.
    expect(toSuggestion({ version: 2, turn: 1, text: 'x', baseSeq: 0, truncated: false, acceptKey: 'Tab' })).toBeUndefined()
    expect(toSuggestion({ version: 1, turn: 1, text: '', baseSeq: 0, truncated: false, acceptKey: 'Tab' })).toBeUndefined()
    expect(toSuggestion({ version: 1, turn: 'nope', text: 'x', baseSeq: 0, truncated: false, acceptKey: 'Tab' })).toBeUndefined()
    expect(toSuggestion(null)).toBeUndefined()
    expect(toSuggestion('nonsense')).toBeUndefined()
  })

  it('serves a current record unchanged', () => {
    expect(toSuggestion(toStoredRecord(SUGGESTION))).toEqual(SUGGESTION)
  })

  it('omits an absent route rather than storing a null one', () => {
    // `exactOptionalPropertyTypes` + a zod `.optional()` field: writing an
    // explicit `undefined` would be rejected by the durable boundary.
    expect(toStoredRecord(SUGGESTION)).not.toHaveProperty('route')
    const withRoute = { ...SUGGESTION, route: { provider: 'p', model: 'm' } }
    expect(toSuggestion(toStoredRecord(withRoute))?.route).toEqual({ provider: 'p', model: 'm' })
  })
})

/** A one-shot LLM adapter that answers every auxiliary request with fixed text. */
class FixedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly reply: string) { super() }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'text-delta', index: 0, text: this.reply }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** One mounted plugin plus the capture of the channel it registered. */
interface Mounted {
  readonly ctx: Context
  readonly domain: FakeStorageDomain
  readonly adapter: FixedAdapter
  /** Invoke the registered RPC handler, exactly as the transport would. */
  call(endpoint: string, payload: unknown): Promise<{ ok: boolean; value?: unknown; error?: { code: string } }>
}

let mounted: Mounted | undefined

/**
 * Mount the plugin against an in-memory store, capturing the RPC registration so
 * the browser endpoint can be driven without a real transport.
 * @param reply - auxiliary model reply text.
 * @param seed - optional record to pre-populate the store with.
 */
async function mount(reply = 'run the focused suite', seed?: Record<string, unknown>): Promise<Mounted> {
  const ctx = new Context()
  const domain = createFakeDomain()
  if (seed !== undefined) domain.records.set(String(seed.key), seed.value as never)
  installFakeStorage(ctx, domain)

  let handler: ((endpoint: string, payload: unknown) => Promise<never>) | undefined
  ctx.provide('webServer', { register: () => () => undefined } as never)
  ctx.provide('connection', {
    rpc: {
      handle(channel: string, registered: typeof handler) {
        expect(channel).toBe(SUGGEST_RPC_CHANNEL)
        handler = registered
        return async () => undefined
      },
    },
  } as never)

  const adapter = new FixedAdapter(reply)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.llm.registerAdapter(['main'], adapter)
  // Mount through ctx.plugin so activation (including the scoped
  // `ctx.inject(['sessionProjections'], …)` body) is awaited before the test
  // appends anything. A bare `applyPlugin(ctx, config)` returns before that
  // scope resolves and the turn listener would not yet be wired.
  await ctx.plugin({
    name: 'suggest-prompt',
    inject: PLUGIN_INJECT,
    apply: applyPlugin,
    Config: PluginConfig,
  }, CONFIG)

  const result: Mounted = {
    ctx,
    domain,
    adapter,
    async call(endpoint, payload) {
      if (handler === undefined) throw new Error('the plugin registered no RPC handler')
      return await handler(endpoint, payload) as never
    },
  }
  mounted = result
  return result
}

/**
 * Create a session that has completed one turn, so generation has a transcript
 * to build from.
 * @param ctx - mounted context.
 * @param id - session id, which is also the storage key.
 */
function completedTurn(ctx: Context, id: string): { session: ReturnType<Context['sessions']['create']> } {
  const session = ctx.sessions.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'do a thing' }],
  }) as never, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'done a thing' }],
      source: { provider: 'main', model: 'main-model' },
    }),
  } as never, { surfaceOp: 'append' })
  // Route resolution inherits the logged request header; without it the
  // generator fails loud rather than guessing a route.
  session.append('request/header', {
    header: { config: { provider: 'main', model: 'main-model' } },
    reason: 'initial',
  })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return { session }
}

/** Flush pending microtasks and the awaited store open. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

afterEach(async () => {
  await mounted?.ctx.fiber.dispose()
  mounted = undefined
  vi.restoreAllMocks()
})

describe('the browser read endpoint', () => {
  it('serves the stored suggestion for a session', async () => {
    const m = await mount()
    await writeSuggestion(m.domain as never, SessionId('sess-1'), SUGGESTION)
    const result = await m.call(SUGGEST_RPC_GET, { sessionId: 'sess-1' })
    expect(result.ok).toBe(true)
    expect(result.value).toEqual(SUGGESTION)
  })

  it('answers null for a session with no suggestion', async () => {
    const m = await mount()
    const result = await m.call(SUGGEST_RPC_GET, { sessionId: 'nothing-here' })
    expect(result).toEqual({ ok: true, value: null })
  })

  it('answers null for a malformed payload instead of throwing', async () => {
    // The caller is the composer: a bad payload must read as "no suggestion",
    // never as an error rendered where the user is typing.
    const m = await mount()
    for (const payload of [null, undefined, 'sess', 42, {}, { sessionId: '' }, { sessionId: 7 }]) {
      const result = await m.call(SUGGEST_RPC_GET, payload)
      expect(result).toEqual({ ok: true, value: null })
    }
  })

  it('reports an unknown endpoint as a failure', async () => {
    const m = await mount()
    const result = await m.call('nope', { sessionId: 's' })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('unknown-endpoint')
  })

  it('publishes the suggestion it just generated', async () => {
    const m = await mount('run the focused suite')
    completedTurn(m.ctx, 'live')
    await flush()
    expect(m.adapter.requests).toHaveLength(1)
    const result = await m.call(SUGGEST_RPC_GET, { sessionId: 'live' })
    expect(result.value).toMatchObject({ turn: 1, text: 'run the focused suite' })
  })
})

describe('generation writes to the store and never to the session log', () => {
  it('persists one record per completed turn', async () => {
    const m = await mount()
    const { session } = completedTurn(m.ctx, 'one-turn')
    await flush()
    expect(m.domain.puts).toBe(1)
    expect(readSuggestion(m.domain as never, SessionId('one-turn'))).toMatchObject({ turn: 1 })

    // The log-prohibition guarantee: ordinary traffic only, and no event of any
    // kind carries the suggestion.
    const types = session.snapshotEvents().map(event => (event as { type: string }).type)
    expect(types.some(type => type.startsWith('suggest-prompt') || type.startsWith('plugin:suggest-prompt'))).toBe(false)
  })

  it('skips a turn whose suggestion is already stored (reload dedupe)', async () => {
    const m = await mount()
    await writeSuggestion(m.domain as never, SessionId('already'), { ...SUGGESTION, turn: 1 })
    // Only the seeding write above counts; the turn itself must add none.
    const seeded = m.domain.puts
    completedTurn(m.ctx, 'already')
    await flush()
    expect(m.adapter.requests).toHaveLength(0)
    expect(m.domain.puts).toBe(seeded)
  })

  it('stores nothing when the model produces no usable suggestion', async () => {
    const m = await mount('   ')
    completedTurn(m.ctx, 'silent')
    await flush()
    expect(m.adapter.requests).toHaveLength(1)
    expect(m.domain.puts).toBe(0)
  })

  it('warns and stores nothing when the write fails', async () => {
    const m = await mount()
    const warn = vi.spyOn(m.ctx.logger, 'warn').mockImplementation(() => undefined)
    m.domain.failWrites = new Error('disk on fire')
    completedTurn(m.ctx, 'broken')
    await flush()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('suggestion generation failed'))
    expect(m.domain.records.size).toBe(0)
  })
})

/** Keep the type import honest without pulling the value into the program. */
export type { SessionIdType }
