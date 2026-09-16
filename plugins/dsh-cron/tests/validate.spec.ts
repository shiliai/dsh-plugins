import { describe, expect, it } from 'vitest'
import { MAX_WINDOW_SECONDS, normalizeJobSpec, ValidationError } from '../src/validate.ts'

const NOW = Date.UTC(2026, 8, 16, 0, 0)

function baseSpec(): Record<string, unknown> {
  return {
    name: 'mail-digest',
    trigger: { kind: 'cron', expr: '0 8 * * *', timeZone: 'Asia/Shanghai' },
    task: { kind: 'agent', prompt: '总结邮件' },
    window: { endAt: '2027-09-16T00:00:00+08:00' },
  }
}

describe('normalizeJobSpec', () => {
  it('accepts a valid spec and applies defaults', () => {
    const spec = normalizeJobSpec(baseSpec(), NOW)
    expect(spec.name).toBe('mail-digest')
    expect(spec.timeoutSeconds).toBe(600)
    expect(spec.overlap).toBe('skip')
    expect(spec.misfire).toBe('skip')
    expect(spec.trigger).toEqual({ kind: 'cron', expr: '0 8 * * *', timeZone: 'Asia/Shanghai' })
  })

  it('rejects bad names', () => {
    expect(() => normalizeJobSpec({ ...baseSpec(), name: '' }, NOW)).toThrow(ValidationError)
    expect(() => normalizeJobSpec({ ...baseSpec(), name: 'has space' }, NOW)).toThrow(/名称/)
  })

  it('requires an explicit time zone for cron triggers', () => {
    const spec = baseSpec()
    ;(spec.trigger as Record<string, unknown>).timeZone = ''
    expect(() => normalizeJobSpec(spec, NOW)).toThrow(/timeZone/)
    ;(spec.trigger as Record<string, unknown>).timeZone = 'Mars/Olympus'
    expect(() => normalizeJobSpec(spec, NOW)).toThrow(/时区/)
  })

  it('enforces the minimum interval', () => {
    const spec = { ...baseSpec(), trigger: { kind: 'interval', everySeconds: 30 } }
    expect(() => normalizeJobSpec(spec, NOW)).toThrow(/60/)
  })

  it('requires RFC 3339 with offset for one-shot triggers', () => {
    const spec = { ...baseSpec(), trigger: { kind: 'oneshot', at: '2026-09-20T08:00:00' } }
    expect(() => normalizeJobSpec(spec, NOW)).toThrow(/RFC 3339/)
    const ok = { ...baseSpec(), trigger: { kind: 'oneshot', at: '2026-09-20T08:00:00.000Z' } }
    expect(normalizeJobSpec(ok, NOW).trigger.kind).toBe('oneshot')
  })

  it('forbids looping jobs without a validity window', () => {
    const spec = baseSpec()
    delete spec.window
    expect(() => normalizeJobSpec(spec, NOW)).toThrow(/有效期/)
    const oneshot = { ...spec, trigger: { kind: 'oneshot', at: '2026-09-20T08:00:00Z' } }
    expect(() => normalizeJobSpec(oneshot, NOW)).not.toThrow()
  })

  it('caps the window at one year', () => {
    const spec = { ...baseSpec(), window: { maxDurationSeconds: MAX_WINDOW_SECONDS + 1 } }
    expect(() => normalizeJobSpec(spec, NOW)).toThrow(/一年/)
  })

  it('validates the live cron expression by computing a next fire', () => {
    const spec = { ...baseSpec(), trigger: { kind: 'cron', expr: '0 0 30 2 *', timeZone: 'Asia/Shanghai' } }
    expect(() => normalizeJobSpec(spec, NOW)).toThrow(/一年内|匹配/)
  })

  it('requires prompt for agent tasks and argv for command tasks', () => {
    expect(() => normalizeJobSpec({ ...baseSpec(), task: { kind: 'agent', prompt: ' ' } }, NOW)).toThrow(/prompt/)
    expect(() => normalizeJobSpec({ ...baseSpec(), task: { kind: 'command' } }, NOW)).toThrow(/argv/)
    const ok = normalizeJobSpec({ ...baseSpec(), task: { kind: 'command', argv: ['/bin/echo', 'hi'] } }, NOW)
    expect(ok.task).toEqual({ kind: 'command', argv: ['/bin/echo', 'hi'] })
  })

  it('keeps agent-only fields out of command tasks', () => {
    const spec = { ...baseSpec(), task: { kind: 'command', argv: ['/bin/true'] }, agentPreset: 'ops-bot' }
    expect(() => normalizeJobSpec(spec, NOW)).toThrow(/Agent 预设/)
    const spec2 = { ...baseSpec(), task: { kind: 'command', argv: ['/bin/true'] }, model: { provider: 'p', model: 'm' } }
    expect(() => normalizeJobSpec(spec2, NOW)).toThrow(/模型/)
  })

  it('normalizes command delivery', () => {
    const spec = normalizeJobSpec({ ...baseSpec(), delivery: { kind: 'command', argv: ['./notify.sh'] } }, NOW)
    expect(spec.delivery).toEqual({ kind: 'command', argv: ['./notify.sh'], onFailureOnly: true, timeoutSeconds: 60 })
  })
})
