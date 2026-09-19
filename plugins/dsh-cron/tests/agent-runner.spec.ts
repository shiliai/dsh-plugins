import { describe, expect, it } from 'vitest'
import { summarizeAssistant, usageOf } from '../src/agent-runner.ts'
import type { SessionEventLike } from '../src/agent-runner.ts'

type UsageRecord = NonNullable<NonNullable<SessionEventLike['data']>['usage']>

function assistant(seq: number, usage: UsageRecord): SessionEventLike {
  return { seq, type: 'assistant/message', data: { message: { content: [] }, usage } }
}

describe('usageOf', () => {
  it('sums usage across the run window and keeps unreported figures absent', () => {
    const events: SessionEventLike[] = [
      { seq: 1, type: 'turn/start' },
      assistant(2, { inputTokens: 100, outputTokens: 40, cacheReadTokens: 10 }),
      { seq: 3, type: 'tool/call' },
      assistant(4, { inputTokens: 30, outputTokens: 12, reasoningTokens: 7 }),
    ]
    expect(usageOf(events, 2)).toEqual({
      inputTokens: 130,
      outputTokens: 52,
      cacheReadTokens: 10,
      reasoningTokens: 7,
    })
  })

  it('ignores events before firstSeq, non-numeric values, and non-usage events', () => {
    const events: SessionEventLike[] = [
      assistant(1, { inputTokens: 999 }),
      { seq: 2, type: 'assistant/message', data: { message: { content: [] } } },
      assistant(3, { inputTokens: Number.NaN, outputTokens: -5, cacheWriteTokens: 4 }),
    ]
    expect(usageOf(events, 2)).toEqual({ cacheWriteTokens: 4 })
  })

  it('returns undefined when nothing reported', () => {
    expect(usageOf([{ seq: 1, type: 'turn/start' }], 0)).toBeUndefined()
  })
})

describe('summarizeAssistant', () => {
  it('caps long summaries with an ellipsis', () => {
    expect(summarizeAssistant('x'.repeat(2001))).toHaveLength(2001)
    expect(summarizeAssistant('ok')).toBe('ok')
  })
})
