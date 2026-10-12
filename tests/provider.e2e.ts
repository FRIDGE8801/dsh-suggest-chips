import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as suggestPromptPlugin from '@studyzy/dsh-suggest-prompt'
import { createFakeDomain } from './storage.ts'
import type { FakeStorageDomain } from './storage.ts'

const contexts: Context[] = []
const domains: FakeStorageDomain[] = []

afterEach(async () => {
  domains.length = 0
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('suggest-prompt with real DeepSeek API', () => {
  it('generates a non-empty suggestion from a real DeepSeek call', async () => {
    // Legacy manual lane (excluded from `pnpm test`). The durable suggestion now
    // lands in the plugin's own storage domain, so this lane installs the same
    // in-memory domain double the unit lane uses instead of a record writer.
    const domain = createFakeDomain()
    domains.push(domain)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmDeepSeek, { thinking: 'disabled' })
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.// The RPC channel registers itself as an HTTP route through `webServer`
    await ctx.// (`connection.rpc.handle` calls `owner.webServer.register`), so the plugin
    await ctx.// injects it and every mount must provide it.
    await ctx.provide('webServer', { register: () => () => undefined } as never)
    await ctx.provide('connection', {
      rpc: { handle: () => async () => {} },
    } as never)
    await ctx.provide('storageDomain', {
      open: async () => domain,
    } as never)
    await ctx.plugin(suggestPromptPlugin, {
      maxInputBytes: 4096,
      maxOutputTokens: 64,
      timeoutMs: 60000,
      maxRecentTurns: 10,
      maxTranscriptChars: 12000,
      maxSuggestionChars: 240,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })
    const session = ctx.sessions.create(SessionId('real-api-suggest'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '帮我写一个防抖函数' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1, step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: '防抖函数如下，它会在最后一次调用后等待 delay 毫秒再执行。' }],
        source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      }),
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await new Promise(resolve => setTimeout(resolve, 50))
    const stored = domain.records.get('real-api-suggest')
    expect(stored).toBeDefined()
    expect(stored?.text.length).toBeGreaterThan(0)
    // Nothing suggestion-shaped ever enters the session log.
    expect(session.snapshotEvents().map(event => event.type as string)
      .filter(type => type.startsWith('suggest-prompt') || type.startsWith('plugin:'))).toEqual([])
  })
})