import { describe, expect, it } from 'vitest'
import { extractTextFromFrame, summarizeTurn } from '../src/frame.ts'

describe('extractTextFromFrame', () => {
  it('extracts plain text content', () => {
    const frame = { body: { text: { content: '  hello  世界 ' } } }
    expect(extractTextFromFrame(frame as never)).toBe('hello  世界')
  })

  it('returns empty for no text', () => {
    expect(extractTextFromFrame({ body: {} } as never)).toBe('')
    expect(extractTextFromFrame({ body: { image: {} } } as never)).toBe('')
  })
})

describe('summarizeTurn', () => {
  it('aggregates last assistant text and reports completion', () => {
    const events = [
      { seq: 0, type: 'turn/start', data: {} },
      { seq: 1, type: 'assistant/message', data: { message: { content: [
        { type: 'text', text: '你好，' },
        { type: 'text', text: '世界！' },
      ] } } },
      { seq: 2, type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ]
    const r = summarizeTurn(events as never, 0)
    expect(r.text).toBe('你好，世界！')
    expect(r.ok).toBe(true)
  })

  it('ignores events before firstSeq', () => {
    const events = [
      { seq: 0, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '旧' }] } } },
      { seq: 1, type: 'turn/start', data: {} },
      { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '新' }] } } },
      { seq: 3, type: 'turn/end', data: { reason: { kind: 'error' } } },
    ]
    const r = summarizeTurn(events as never, 1)
    expect(r.text).toBe('新')
    expect(r.ok).toBe(false)
  })
})
