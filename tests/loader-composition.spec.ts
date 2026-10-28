import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import LlmRuntime, { createAssistantMessage, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as suggestChipsPlugin from 'dsh-suggest-chips'
import { Config } from 'dsh-suggest-chips'
import { createFakeDomain, installFakeStorage } from './storage.ts'
import type { FakeStorageDomain } from './storage.ts'

/**
 * Mirror the host's `volatileForm()` projection: walk a schema and report the
 * field paths whose node is marked volatile. `dsh >= 0.2.0` derives a plugin's
 * settings page from the schema, and an entry with no volatile field is omitted
 * from `settings.describe` entirely — which makes the WebUI card mount and then
 * render nothing.
 * @param schema - a schemastery node.
 * @returns volatile field paths (a wholly volatile node reports its own key).
 */
function volatileFieldPaths(schema: { meta?: { volatile?: boolean }; type?: string; dict?: Record<string, unknown> }): string[] {
  if (schema.meta?.volatile === true) return ['<node>']
  if (schema.type !== 'object') return []
  return Object.entries(schema.dict ?? {}).flatMap(([key, child]) => volatileFieldPaths(child as never)
    .map(path => (path === '<node>' ? key : `${key}.${path}`)))
}

describe('suggest-chips settings schema', () => {
  it('marks the user-editable preferences volatile so the host describes the entry', () => {
    // Without this, the settings card is unreachable: the host omits an entry
    // with no volatile field from the describe answer the client reads.
    expect(volatileFieldPaths(Config as never).sort()).toEqual(['model', 'provider'])
  })

  it('keeps the deployment bounds out of the generated settings form', () => {
    // The numeric bounds are composition policy, not user preferences; they must
    // not become editable form fields.
    const paths = volatileFieldPaths(Config as never)
    for (const bound of ['maxInputBytes', 'maxOutputTokens', 'timeoutMs', 'maxRecentTurns', 'maxTranscriptChars', 'maxSuggestionChars', 'maxSuggestions']) {
      expect(paths).not.toContain(bound)
    }
  })
})

let root: string | undefined
let context: Context | undefined
/** The in-memory store the composed plugin persists into. */
let domain: FakeStorageDomain | undefined

class LoaderAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'text-delta', index: 0, text: 'Loader composed suggestion' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Minimal `ctx.connection.fetch` stand-in for the browser read route. */
const routeStandin = {
  register: () => () => {},
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  domain = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadComposition(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-suggest-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: 'dsh-suggest-chips'",
    '  config:',
    '    maxInputBytes: 1000',
    '    maxOutputTokens: 32',
    '    timeoutMs: 1000',
    '    maxRecentTurns: 3',
    '    maxTranscriptChars: 500',
    '    maxSuggestionChars: 40',
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  // The plugin declares `storageDomain` and `connection`; a real profile gets
  // both from `@deepseek-ai/dsh-base`, so the composition must provide them
  // before the entry activates.
  domain = createFakeDomain()
  installFakeStorage(context, domain)
  context.provide('connection', { fetch: routeStandin } as never)
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['dsh-suggest-chips', suggestChipsPlugin],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

describe('suggest-chips Loader composition', () => {
  it('loads the plugin with required deployment policy and generates on a completed turn', async () => {
    const ctx = await loadComposition()
    const unloaded = [...ctx.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])

    const adapter = new LoaderAdapter()
    ctx.llm.registerAdapter(['main'], adapter)
    const session = ctx.sessions.create(SessionId('loader-suggest'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '组合测试' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1, step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: '组合回答' }],
        source: { provider: 'main', model: 'main-model' },
      }),
    }, { surfaceOp: 'append' })
    session.append('request/header', {
      header: { config: { provider: 'main', model: 'main-model' } }, reason: 'initial',
    })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({ provider: 'main', model: 'main-model' })
    // `snapshotEvents()` is the sanctioned inspection reader for repository tests
    // (rc.2 removed the bare `events` accessor and prohibits new synchronous
    // history reads in production code). The suggestion must NOT appear there:
    // durability went to the plugin's own storage domain.
    const logged = session.snapshotEvents().map(event => event.type as string)
    expect(logged.filter(type => type.startsWith('suggest-chips') || type.startsWith('plugin:'))).toEqual([])

    expect(domain?.puts).toBe(1)
    expect(domain?.records.get('loader-suggest')).toMatchObject({
      version: 2,
      turn: 1,
      suggestions: ['Loader composed suggestion'],
    })
  })
})
