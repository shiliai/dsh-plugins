import { describe, expect, it } from 'vitest'
import { DEFAULT_WORKER, expandHome, normalizeConfig } from '../src/config.ts'

describe('config normalizeConfig', () => {
  it('applies documented defaults', () => {
    const config = normalizeConfig({})
    expect(config.apiKey).toBe(process.env.JEV_API_KEY ?? null)
    expect(config.jevModel).toBe('jev-latest')
    expect(config.workers).toEqual([DEFAULT_WORKER])
    expect(config.minConfidence).toBe(0.6)
    expect(config.complexityThreshold).toBe(2)
    expect(config.subagentProvider).toBe('spawn')
    expect(config.maxDepth).toBe(0)
    expect(config.jevTimeoutMs).toBe(10000)
    expect(config.timeoutMs).toBe(600000)
    expect(config.statsFile).toBe(expandHome('~/.dsh/agent-team/routing-stats.jsonl'))
    expect(config.statsFile).not.toContain('~')
  })

  it('prefers an explicit apiKey over the environment', () => {
    const config = normalizeConfig({ apiKey: 'configured-key' })
    expect(config.apiKey).toBe('configured-key')
  })

  it('treats an empty apiKey as unset (falls back to env, then null)', () => {
    const config = normalizeConfig({ apiKey: '   ' })
    expect(config.apiKey).toBe(process.env.JEV_API_KEY ?? null)
  })

  it('rejects out-of-range thresholds', () => {
    for (const minConfidence of [0, -0.1, 1.1, Number.NaN, '0.6' as unknown as number]) {
      expect(() => normalizeConfig({ minConfidence }), `minConfidence=${String(minConfidence)}`).toThrow('minConfidence')
    }
    for (const complexityThreshold of [-1, 4.1, Number.NaN, '2' as unknown as number]) {
      expect(() => normalizeConfig({ complexityThreshold }), `complexityThreshold=${String(complexityThreshold)}`).toThrow('complexityThreshold')
    }
  })

  it('rejects invalid timeouts and maxDepth', () => {
    expect(() => normalizeConfig({ jevTimeoutMs: 0 })).toThrow('jevTimeoutMs')
    expect(() => normalizeConfig({ timeoutMs: -1 })).toThrow('timeoutMs')
    expect(() => normalizeConfig({ maxDepth: 1.5 })).toThrow('maxDepth')
    expect(() => normalizeConfig({ maxDepth: -1 })).toThrow('maxDepth')
  })

  it('rejects empty workers and malformed worker entries', () => {
    expect(() => normalizeConfig({ workers: [] })).toThrow('workers')
    expect(() => normalizeConfig({ workers: [{ name: '', provider: 'p', model: 'm', description: 'd' }] })).toThrow('name')
    expect(() => normalizeConfig({ workers: [{ name: 'w', provider: 'p', model: '', description: 'd' }] })).toThrow('model')
    expect(() => normalizeConfig({ workers: [{ name: 'w', provider: 'p', model: 'm', description: ' ' }] })).toThrow('description')
    expect(() => normalizeConfig({
      workers: [
        { name: 'w', provider: 'p', model: 'm', description: 'd' },
        { name: 'w', provider: 'p2', model: 'm2', description: 'd2' },
      ],
    })).toThrow('duplicate')
  })

  it('honors statsFile: null disables, other paths are home-expanded', () => {
    expect(normalizeConfig({ statsFile: null }).statsFile).toBeNull()
    expect(normalizeConfig({ statsFile: '~/x.jsonl' }).statsFile).toBe(expandHome('~/x.jsonl'))
    expect(normalizeConfig({ statsFile: '/abs/x.jsonl' }).statsFile).toBe('/abs/x.jsonl')
  })

  it('copies configured workers (no shared mutation with the caller)', () => {
    const workers = [{ name: 'w', provider: 'p', model: 'm', description: 'd' }]
    const config = normalizeConfig({ workers })
    workers[0]!.description = 'mutated'
    expect(config.workers[0]!.description).toBe('d')
  })
})
