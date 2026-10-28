/**
 * Bounded auxiliary suggestion generation: transcript framing, secret
 * redaction, route resolution, deadline-fused LLM dispatch, and output
 * sanitization. Generation is PURE with respect to durability: it returns the
 * suggestion payload and the caller persists it through the plugin's own
 * storage domain (see ./records.ts). Nothing is ever written to the session
 * log — that is what made sessions unreadable (issue #4).
 * @module dsh-suggest-chips/generate
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  BlockAssembler,
  createUserMessage,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { SuggestPromptStorageRecord } from './domain.ts'
import { hasCJK, parseSuggestionList } from './sanitize.ts'
import type { SuggestPromptTranscriptState } from './types.ts'
import type { Config } from './index.ts'

/** Capability-owned timeout reason code for auxiliary suggestion requests. */
export const SUGGEST_PROMPT_TIMEOUT_CODE = 'SUGGEST_PROMPT_TIMEOUT'

/**
 * Suggestion generation is an opportunistic, must-be-fast-and-cheap auxiliary
 * call: reasoning/thinking is disabled. `off` maps to `thinking: disabled` on
 * the DeepSeek adapter and to `reasoning_effort: off` on OpenAI-compatible
 * (pi-ai) routes, so the request never spends budget on a chain of thought.
 */
const SUGGEST_REASONING_EFFORT = ReasoningEffortId('off')

/**
 * Informational purpose tag for auxiliary suggestion calls. The published
 * `GenerateOptions['purpose']` union predates the suggest-chips capability and
 * no provider tailors transport for it yet, so the literal widens through
 * `unknown` once; the runtime value stays `'suggest-chips'` for providers that
 * learn it later.
 */
const SUGGEST_PURPOSE = 'suggest-chips' as unknown as Exclude<GenerateOptions['purpose'], undefined>

/** Validated immutable suggestion policy. */
export interface ResolvedSuggestPromptConfig extends Config {}

/** Complete configuration key set for direct construction validation. */
const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'maxInputBytes',
  'maxOutputTokens',
  'timeoutMs',
  'maxRecentTurns',
  'maxTranscriptChars',
  'maxSuggestionChars',
  'maxSuggestions',
  'provider',
  'model',
])

/** Validate one positive integer limit. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`suggest-chips: ${name} must be a positive integer`)
  }
}

/**
 * Read one configuration field as plain data.
 *
 * `dsh >= 0.2.0` settings expose a `volatile()`-marked field as a live
 * reference (`{ get(), set() }`) rather than the value itself, so the loader
 * hands this plugin reference objects for exactly the fields the settings form
 * may edit live. Everything downstream wants plain JSON, so unwrap here — at
 * the one boundary where untrusted config enters — rather than at each read.
 * A non-reference value passes through unchanged, which keeps the plugin usable
 * with a plain config object (tests, direct composition).
 * @param value - a config field, possibly a volatile reference.
 * @returns the plain value.
 */
function readConfigField(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    return (value as { get(): unknown }).get()
  }
  return value
}

/**
 * Unwrap every volatile reference in a config object, dropping `undefined`
 * fields so an absent optional stays absent rather than becoming an explicit
 * undefined key.
 * @param config - the raw plugin config.
 * @returns a plain object of resolved values.
 */
function unwrapVolatileFields(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(config)) {
    const value = readConfigField(raw)
    if (value !== undefined) out[key] = value
  }
  return out
}

/**
 * Validate and detach the required suggestion policy.
 * @param config - untrusted plugin configuration.
 * @returns immutable policy with optional route absence preserved.
 */
export function resolveSuggestPromptConfig(config: Config): ResolvedSuggestPromptConfig {
  const candidate: unknown = config
  if (candidate === null || typeof candidate !== 'object') {
    throw new Error('suggest-chips: configuration is required')
  }
  const value = unwrapVolatileFields(candidate as Record<string, unknown>) as unknown as Config
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`suggest-chips: unknown config key "${key}"`)
  }
  assertPositiveInteger('maxInputBytes', value.maxInputBytes)
  assertPositiveInteger('maxOutputTokens', value.maxOutputTokens)
  assertPositiveInteger('timeoutMs', value.timeoutMs)
  if (value.maxRecentTurns !== undefined) assertPositiveInteger('maxRecentTurns', value.maxRecentTurns)
  assertPositiveInteger('maxTranscriptChars', value.maxTranscriptChars)
  assertPositiveInteger('maxSuggestionChars', value.maxSuggestionChars)
  if (value.maxSuggestions !== undefined) assertPositiveInteger('maxSuggestions', value.maxSuggestions)
  if (value.timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`suggest-chips: timeoutMs must not exceed ${MAX_TIMER_DELAY_MS}`)
  }
  // provider and model are independent per-field overrides of the session route:
  // either may be set alone and the missing member falls back to the session's
  // latest logged route (see routeOf). Only a present override is validated.
  if (value.provider !== undefined
    && (typeof value.provider !== 'string' || value.provider.length === 0)) {
    throw new Error('suggest-chips: provider override must be a non-empty string')
  }
  if (value.model !== undefined
    && (typeof value.model !== 'string' || value.model.length === 0)) {
    throw new Error('suggest-chips: model override must be a non-empty string')
  }
  return deepFreeze(Object.assign({}, value))
}

/**
 * Stable instruction for the suggestion extraction call. The model is bound to
 * predicting the user's next prompts in the user's own voice, forbidden from
 * generating content or meta-text, and must answer with a JSON string array of
 * two to `maxSuggestions` short candidates; `language` constrains the reply
 * language to match the conversation.
 * @param maxSuggestionChars - visible-character cap baked into the instruction.
 * @param language - reply language ("简体中文" for CJK conversations, else "English").
 * @param maxSuggestions - hard cap on returned candidates.
 */
export function systemPrompt(maxSuggestionChars: number, language: string, maxSuggestions: number): string {
  return [
    'You are a prompt suggestion generator. Your ONLY purpose is to predict the user\'s likely next prompts in a coding-assistant chat — never to generate content.',
    '',
    'Your job:',
    '1. Read the user\'s most recent message and the assistant\'s final answer.',
    '2. Predict what the USER would naturally type next — not what the assistant should do.',
    `3. Offer between 2 and ${maxSuggestions} distinct candidates, most likely first.`,
    '',
    'CRITICAL CONSTRAINTS:',
    '- You are NOT a code generator, writer, or task executor.',
    '- You MUST respond with ONLY a JSON array of strings, e.g. ["run the tests","commit this"].',
    '- NEVER generate, implement, code, or produce any content.',
    '- NEVER provide explanations, reasoning, or text outside the JSON array.',
    '- NEVER use labels, Markdown, XML, or code fences.',
    '- Be specific when you can — name files, functions, or actions.',
    '- Candidates must be distinct next steps, not rephrasings of one step.',
    '- If no next step is obvious, reply with an empty array [].',
    '',
    'THE TEST: would the user think "I was just about to type that"?',
    '',
    'EXAMPLES:',
    'User asked "fix the bug and run tests", bug is fixed -> ["run the tests","commit the fix","show the diff"]',
    'After code written -> ["try it out","add a test for this"]',
    'Assistant offers options -> list the options the user would pick',
    'Task complete, obvious follow-up -> ["commit this","push it"]',
    'After an error or misunderstanding -> []',
    '',
    'NEVER SUGGEST:',
    '- Evaluative feedback ("looks good", "thanks")',
    '- Questions ("what about...?")',
    '- Assistant-voice phrasing ("Let me...", "I\'ll...", "Here\'s...")',
    '- New ideas the user did not ask about',
    '- Multiple sentences per candidate',
    '',
    `Reply with ONLY a JSON array of 2-${maxSuggestions} strings, 2-10 words each, no quotes beyond the JSON syntax, no explanation. Each candidate at most ${maxSuggestionChars} visible characters.`,
    '',
    `Language: ${language}`,
  ].join('\n')
}

/** Pick the reply language to match the user's last prompt (CJK → 简体中文). */
export function suggestionLanguage(pairs: readonly TranscriptPair[]): string {
  for (const pair of [...pairs].reverse()) {
    if (pair.role !== 'user') continue
    return hasCJK(pair.text) ? '简体中文' : 'English'
  }
  return 'English'
}

/** Frame the kept pairs as labelled blocks so the model reads them as context. */
function frameTranscript(pairs: readonly TranscriptPair[]): string {
  const blocks: string[] = []
  for (const pair of pairs) {
    blocks.push(pair.role === 'user' ? `[User Message]\n${pair.text}` : `[Assistant Response]\n${pair.text}`)
  }
  return blocks.join('\n\n')
}

/** One redacted user/assistant exchange line ready for framing. */
export interface TranscriptPair {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

/** The bounded transcript handed to the model, plus its log attribution. */
export interface Transcript {
  readonly pairs: readonly TranscriptPair[]
  readonly sourceMessageSeqs: readonly number[]
  readonly baseSeq: number
}

/** Keep the newest pairs while the budget lasts; always keep the newest one. */
function keepTail(pairs: readonly TranscriptPair[], budget: number): number {
  let remaining = budget
  let kept = 0
  for (const pair of [...pairs].reverse()) {
    const cost = pair.role.length + pair.text.length + 2
    if (cost > remaining && kept > 0) break
    kept += 1
    remaining -= cost
  }
  return Math.max(1, kept)
}

/**
 * Build the model-visible transcript from the retained fold state: user and
 * assistant pairs of the last `maxRecentTurns` completed turns (default 1 —
 * only the last completed turn's user input and assistant final answer),
 * tail-trimmed to `maxTranscriptChars`.
 *
 * The state arrives pre-redacted and pre-filtered from
 * `applyTranscriptProjection`; this function only bounds the window and the
 * character budget. Reading fold state — rather than scanning session history
 * — is what keeps the plugin clear of the deprecated synchronous history
 * readers.
 * @param state - the retained `suggestPromptTranscript` fold state.
 * @param maxRecentTurns - completed-turn tail to include (1 keeps only the last turn).
 * @param maxTranscriptChars - character budget for the kept tail.
 * @returns the bounded transcript, or `undefined` when the window holds no text.
 */
export function buildTranscript(
  state: SuggestPromptTranscriptState,
  maxRecentTurns: number,
  maxTranscriptChars: number,
): Transcript | undefined {
  const lastTurn = state.lastCompletedTurn
  if (lastTurn === 0) return undefined
  const cutoffTurn = Math.max(1, lastTurn - Math.max(1, maxRecentTurns) + 1)
  const inWindow = state.entries.filter(entry => entry.turn >= cutoffTurn)
  if (inWindow.length === 0) return undefined
  const pairs: TranscriptPair[] = inWindow.map(entry => ({ role: entry.role, text: entry.text }))
  const sourceMessageSeqs = inWindow.map(entry => entry.seq)
  const keptCount = keepTail(pairs, Math.max(1, maxTranscriptChars))
  const kept = pairs.slice(pairs.length - keptCount)
  const keptSeqs = sourceMessageSeqs.slice(sourceMessageSeqs.length - keptCount)
  return {
    pairs: kept,
    sourceMessageSeqs: keptSeqs,
    // keptSeqs is a tail slice, so the newest retained seq is the baseSeq.
    baseSeq: keptSeqs[keptSeqs.length - 1] ?? 0,
  }
}

/**
 * Resolve the effective route: an explicit override wins for a member, and a
 * missing member falls back to the session's latest logged request route.
 * @param session - session whose logged request header supplies the fallback.
 * @param config - validated suggestion policy.
 * @returns the complete route, or throws when neither a configured pair nor a
 * logged session route supplies every member.
 */
function routeOf(
  session: Session,
  config: ResolvedSuggestPromptConfig,
): { readonly provider: string; readonly model: string } {
  if (config.provider !== undefined && config.model !== undefined) {
    return { provider: config.provider, model: config.model }
  }
  const route = session.requestHeader()?.config
  const provider = config.provider ?? route?.provider
  const model = config.model ?? route?.model
  if (provider !== undefined && model !== undefined && provider.length > 0 && model.length > 0) {
    return { provider, model }
  }
  throw new Error('suggest-chips: no complete route is available; configure provider and model, or run a turn that logs a session route')
}

/** Translate terminal finish reasons into an auxiliary-call failure. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens':
      return new Error('suggest-chips: suggestion output reached maxOutputTokens')
    case 'tool-calls':
      return new Error('suggest-chips: suggestion model unexpectedly requested a tool')
    /* v8 ignore next 2 -- FinishReason is a closed five-member union; this default cannot be reached */
    default:
      return new Error(`suggest-chips: unsupported finish reason "${String((finish as { kind?: unknown }).kind)}"`)
  }
}

/**
 * Generate one suggestion for a completed turn through the shared auxiliary
 * LLM call.
 * @param ctx - context exposing the registered LLM service.
 * @param config - validated suggestion policy.
 * @param session - owning session log.
 * @param turn - completed turn whose completion this suggestion answers.
 * @param signal - cancellation forwarded to the auxiliary call.
 * @returns the generated suggestion payload, or `undefined` when the model
 * produced no usable suggestion (an empty or semantically rejectable reply —
 * the system prompt tells it to reply with nothing when the next step is not
 * obvious). Genuine failures throw. Persisting the result is the caller's job.
 */
export async function generateSuggestion(
  ctx: Context,
  config: ResolvedSuggestPromptConfig,
  session: Session,
  turn: number,
  transcriptState: SuggestPromptTranscriptState,
  signal: AbortSignal,
): Promise<SuggestPromptStorageRecord | undefined> {
  signal.throwIfAborted()
  const transcript = buildTranscript(transcriptState, config.maxRecentTurns ?? 1, config.maxTranscriptChars)
  if (transcript === undefined) {
    throw new Error('suggest-chips: session has no model-visible transcript to suggest from')
  }
  const route = routeOf(session, config)
  const language = suggestionLanguage(transcript.pairs)
  const system = systemPrompt(config.maxSuggestionChars, language, config.maxSuggestions ?? 3)
  const framed = frameTranscript(transcript.pairs)
  const inputBytes = Buffer.byteLength(framed, 'utf8')
  if (inputBytes > config.maxInputBytes) {
    throw new Error(`suggest-chips: input is ${inputBytes} bytes, exceeding maxInputBytes ${config.maxInputBytes}`)
  }
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: framed }],
    source: { kind: 'suggest-chips', plugin: 'dsh-suggest-chips', form: 'transcript' },
  })]
  using callDeadline = deadline(signal, config.timeoutMs, SUGGEST_PROMPT_TIMEOUT_CODE)
  const requestOptions = (reasoningOff: boolean): GenerateOptions => deepFreeze({
    provider: route.provider,
    model: route.model,
    messages,
    system,
    maxTokens: config.maxOutputTokens,
    sessionId: session.id,
    purpose: SUGGEST_PURPOSE,
    ...(reasoningOff ? { reasoningEffort: SUGGEST_REASONING_EFFORT } : {}),
    signal: callDeadline.signal,
  })
  // The request is tried reasoning-off first (fast and cheap); a model whose
  // adapter rejects `off` (UNSUPPORTED_REASONING_EFFORT) retries without the
  // override so a suggestion still generates. Nothing is logged per attempt —
  // the only durable trace of the exchange is the suggestion record below.
  callDeadline.signal.throwIfAborted()
  const drain = async (options: GenerateOptions): Promise<ReturnType<BlockAssembler['blocks']>> => {
    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream(options)) {
      callDeadline.signal.throwIfAborted()
      assembler.push(chunk)
    }
    callDeadline.signal.throwIfAborted()
    const terminalError = finishError(assembler.finish)
    if (terminalError !== undefined) throw terminalError
    return assembler.blocks()
  }
  let blocks: ReturnType<BlockAssembler['blocks']>
  try {
    blocks = await drain(requestOptions(true))
  } catch (error: unknown) {
    if ((error as { code?: unknown } | null)?.code !== 'UNSUPPORTED_REASONING_EFFORT') throw error
    blocks = await drain(requestOptions(false))
  }
  if (blocks.some(block => block.type === 'tool-call')) {
    throw new Error('suggest-chips: suggestion output must contain text only')
  }
  const text = blocks
    .filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  // Parse the model's JSON array (fenced or not) into chip-safe candidates. An
  // empty array or an all-filtered reply is a normal "no suggestion" (the
  // prompt tells the model to answer [] when the next step is not obvious),
  // not a failure.
  const suggestions = parseSuggestionList(
    text,
    config.maxSuggestionChars,
    config.maxSuggestions ?? 3,
  )
  if (suggestions.length === 0) return undefined
  return {
    version: 2,
    turn,
    baseSeq: transcript.baseSeq,
    suggestions,
    route,
  }
}
