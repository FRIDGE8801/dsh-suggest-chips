/**
 * Chip visibility is deliberately independent of the composer draft: typing
 * must not retire the tips before the user decides whether to send. Only a
 * running agent or an in-flight submission hides them.
 */
import { describe, expect, it } from 'vitest'
import { visibleSuggestions } from '../src/browser/SuggestionChips.tsx'
import type { SuggestPromptSuggestion } from '../src/types.ts'

const SUGGESTION: SuggestPromptSuggestion = {
  turn: 3,
  baseSeq: 7,
  suggestions: ['继续解释', '给一个例子'],
}

describe('visibleSuggestions', () => {
  it('shows the stored chips while the agent is idle in the plain phase', () => {
    expect(visibleSuggestions(SUGGESTION, false, 'plain')).toEqual(['继续解释', '给一个例子'])
  })

  it('hides the chips while the agent is running', () => {
    expect(visibleSuggestions(SUGGESTION, true, 'plain')).toEqual([])
  })

  it('hides the chips while a submission is in flight', () => {
    for (const phase of ['adjudicating', 'claimed', 'submitting']) {
      expect(visibleSuggestions(SUGGESTION, false, phase)).toEqual([])
    }
  })

  it('returns no chips without a stored suggestion', () => {
    expect(visibleSuggestions(null, false, 'plain')).toEqual([])
  })
})
