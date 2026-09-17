import { describe, expect, it } from 'vitest'
import { isStaleBeat, lastDueBeat, nextFire, scheduleText, windowEndMs } from '../src/schedule.ts'
import type { CronJob } from '../src/types.ts'

const T0 = Date.UTC(2026, 8, 16, 0, 0)

function makeJob(overrides: Partial<CronJob>): CronJob {
  return {
    id: 'cron-test',
    name: 'test',
    source: 'manual',
    trigger: { kind: 'interval', everySeconds: 3600 },
    task: { kind: 'command', argv: ['/bin/true'] },
    overlap: 'skip',
    misfire: 'skip',
    enabled: true,
    createdAt: T0,
    updatedAt: T0,
    seq: 0,
    ...overrides,
  }
}

describe('interval beats are anchor-aligned', () => {
  it('returns the anchor itself before it arrives', () => {
    const job = makeJob({ anchorMs: T0 + 5 * 60_000 })
    expect(nextFire(job, T0)).toBe(T0 + 5 * 60_000)
  })

  it('snaps to the next multiple of the step after `from`', () => {
    const job = makeJob({ anchorMs: T0 })
    expect(nextFire(job, T0 + 1)).toBe(T0 + 3_600_000)
    expect(nextFire(job, T0 + 3_599_000)).toBe(T0 + 3_600_000)
    expect(nextFire(job, T0 + 3_600_000)).toBe(T0 + 2 * 3_600_000)
  })

  it('finds the latest due beat for misfire handling', () => {
    const job = makeJob({ anchorMs: T0 })
    expect(lastDueBeat(job, T0 + 3_600_000, T0 + 7 * 3_600_000)).toBe(T0 + 7 * 3_600_000)
    expect(lastDueBeat(job, T0 + 7 * 3_600_000, T0 + 7 * 3_600_000)).toBeNull()
  })
})

describe('oneshot triggers', () => {
  const at = new Date(T0 + 60_000).toISOString()

  it('fire once and never again', () => {
    const job = makeJob({ trigger: { kind: 'oneshot', at } })
    expect(nextFire(job, T0)).toBe(T0 + 60_000)
    expect(nextFire(job, T0 + 61_000)).toBeNull()
    expect(lastDueBeat(job, T0, T0 + 61_000)).toBe(T0 + 60_000)
    expect(lastDueBeat(job, T0 + 60_000, T0 + 61_000)).toBeNull()
  })
})

describe('stale beats (misfire detection)', () => {
  it('treats beats within two ticks as fresh and older ones as stale', () => {
    expect(isStaleBeat(T0, T0 + 10_000, 15_000)).toBe(false)
    expect(isStaleBeat(T0, T0 + 31_000, 15_000)).toBe(true)
    // Even a huge tick interval enforces a 30s floor.
    expect(isStaleBeat(T0, T0 + 31_000, 3_600_000)).toBe(false)
  })
})

describe('validity windows', () => {
  it('gate next-fire and archive thresholds', () => {
    const job = makeJob({ window: { endAt: new Date(T0 + 3_600_000).toISOString() } })
    expect(windowEndMs(job)).toBe(T0 + 3_600_000)
    expect(nextFire(job, T0)).not.toBeNull()
    expect(nextFire(job, T0 + 3_600_000)).toBeNull()
  })

  it('maxDurationSeconds counts from creation', () => {
    const job = makeJob({ window: { maxDurationSeconds: 60 } })
    expect(windowEndMs(job)).toBe(T0 + 60_000)
  })

  it('disabled or archived jobs never fire', () => {
    expect(nextFire(makeJob({ enabled: false }), T0)).toBeNull()
    expect(nextFire(makeJob({ archivedAt: T0 }), T0)).toBeNull()
  })
})

describe('scheduleText', () => {
  it('renders each trigger kind', () => {
    expect(scheduleText(makeJob({ trigger: { kind: 'cron', expr: '0 8 * * *', timeZone: 'Asia/Shanghai' } }))).toBe('0 8 * * * (Asia/Shanghai)')
    expect(scheduleText(makeJob({ trigger: { kind: 'interval', everySeconds: 3600 } }))).toBe('每 1 小时')
    expect(scheduleText(makeJob({ trigger: { kind: 'oneshot', at: '2026-09-20T08:00:00+08:00' } }))).toContain('2026-09-20T08:00:00+08:00')
  })
})
