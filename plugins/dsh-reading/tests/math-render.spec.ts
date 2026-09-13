import { describe, expect, it } from 'vitest'
import { splitMathFragments } from '../src/client/math-render.ts'

describe('splitMathFragments', () => {
  it('returns plain text untouched', () => {
    expect(splitMathFragments('普通段落，没有公式。')).toEqual([{ kind: 'text', value: '普通段落，没有公式。' }])
    expect(splitMathFragments('')).toEqual([])
  })

  it('leaves stray or unbalanced delimiters literal', () => {
    expect(splitMathFragments('反斜杠 \\( 未闭合')).toEqual([{ kind: 'text', value: '反斜杠 \\( 未闭合' }])
    expect(splitMathFragments('只有 \\] 结束符')).toEqual([{ kind: 'text', value: '只有 \\] 结束符' }])
  })

  it('keeps empty math bodies literal', () => {
    expect(splitMathFragments('空公式 \\( \\) 而已')).toEqual([
      { kind: 'text', value: '空公式 ' },
      { kind: 'text', value: '\\( \\)' },
      { kind: 'text', value: ' 而已' },
    ])
  })

  it('splits an inline formula out of surrounding prose', () => {
    expect(splitMathFragments('设 \\(S_T\\) 为到期股价')).toEqual([
      { kind: 'text', value: '设 ' },
      { kind: 'math', latex: 'S_T', display: false },
      { kind: 'text', value: ' 为到期股价' },
    ])
  })

  it('recognizes block formulas and trims their bodies', () => {
    expect(splitMathFragments('推导：\\[  g(S_T)=(S_T-K)^+  \\]完毕')).toEqual([
      { kind: 'text', value: '推导：' },
      { kind: 'math', latex: 'g(S_T)=(S_T-K)^+', display: true },
      { kind: 'text', value: '完毕' },
    ])
  })

  it('handles adjacent formulas and nested brackets', () => {
    expect(splitMathFragments('\\(a\\)\\(f(x[1])\\)')).toEqual([
      { kind: 'math', latex: 'a', display: false },
      { kind: 'math', latex: 'f(x[1])', display: false },
    ])
  })

  it('supports multiline block bodies', () => {
    const fragments = splitMathFragments('前文\n\\[\\Pi_T^{long}\n=(S_T-K)^+-C_0\\]后文')
    expect(fragments).toEqual([
      { kind: 'text', value: '前文\n' },
      { kind: 'math', latex: '\\Pi_T^{long}\n=(S_T-K)^+-C_0', display: true },
      { kind: 'text', value: '后文' },
    ])
  })
})
