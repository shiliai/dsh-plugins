import { describe, expect, it } from 'vitest'
import type { Worker } from '../src/config.ts'
import type { JevVerdict } from '../src/jev-client.ts'
import { decide } from '../src/router.ts'

const WORKERS: Worker[] = [
  { name: 'w1', provider: 'p1', model: 'm1', description: 'd1' },
  { name: 'w2', provider: 'p2', model: 'm2', description: 'd2' },
]

const THRESHOLDS = { minConfidence: 0.6, complexityThreshold: 2 }

function verdict(overrides: Partial<Pick<JevVerdict, 'complexity' | 'executor' | 'confidence'>>): JevVerdict {
  return { complexity: 1, executor: 'w1', confidence: 0.9, usage: { input_tokens: 0, output_tokens: 0 }, raw: {}, ...overrides }
}

describe('router decide', () => {
  it('routes to leader when jev picks leader (branch ①)', () => {
    const d = decide(verdict({ executor: 'leader' }), WORKERS, THRESHOLDS)
    expect(d.route).toBe('leader')
  })

  it('routes to leader when confidence is below the minimum (branch ②)', () => {
    const d = decide(verdict({ confidence: 0.59 }), WORKERS, THRESHOLDS)
    expect(d.route).toBe('leader')
  })

  it('routes to leader when complexity is at or above the threshold (branch ③)', () => {
    const d = decide(verdict({ complexity: 2 }), WORKERS, THRESHOLDS)
    expect(d.route).toBe('leader')
    expect(decide(verdict({ complexity: 3.5 }), WORKERS, THRESHOLDS).route).toBe('leader')
  })

  it('routes to leader when the executor names no configured worker (branch ④)', () => {
    const d = decide(verdict({ executor: 'hal-9000' }), WORKERS, THRESHOLDS)
    expect(d.route).toBe('leader')
    if (d.route === 'leader') expect(d.reason).toContain('hal-9000')
  })

  it('routes to the named worker when all guards pass (branch ⑤)', () => {
    const d = decide(verdict({ executor: 'w2' }), WORKERS, THRESHOLDS)
    expect(d).toEqual({ route: 'worker', worker: WORKERS[1], reason: expect.stringContaining('w2') as unknown as string })
  })

  it('accepts confidence exactly at the minimum (boundary, not below)', () => {
    const d = decide(verdict({ confidence: 0.6 }), WORKERS, THRESHOLDS)
    expect(d.route).toBe('worker')
  })

  it('accepts complexity just below the threshold (boundary)', () => {
    const d = decide(verdict({ complexity: 1.99 }), WORKERS, THRESHOLDS)
    expect(d.route).toBe('worker')
  })

  it('rejects complexity exactly at a fractional threshold', () => {
    const d = decide(verdict({ complexity: 1.5 }), WORKERS, { minConfidence: 0.6, complexityThreshold: 1.5 })
    expect(d.route).toBe('leader')
  })
})
