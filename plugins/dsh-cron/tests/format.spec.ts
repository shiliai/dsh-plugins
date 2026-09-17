import { describe, expect, it } from 'vitest'
import { detectPreset, fmtCountdown, fmtDuration, oneYearOutRfc3339, presetExpr } from '../src/client/format.ts'

const MINUTE = 60_000
const HOUR = 3_600_000

describe('preset expressions', () => {
  it('build and reverse-detect round-trip', () => {
    expect(presetExpr('hourly', 8, 30)).toBe('30 * * * *')
    expect(presetExpr('daily', 8, 5)).toBe('5 8 * * *')
    expect(presetExpr('weekdays', 9, 15)).toBe('15 9 * * 1-5')
    expect(presetExpr('weekly', 10, 0)).toBe('0 10 * * 1')
    expect(detectPreset('30 * * * *')).toBe('hourly')
    expect(detectPreset('5 8 * * *')).toBe('daily')
    expect(detectPreset('15 9 * * 1-5')).toBe('weekdays')
    expect(detectPreset('0 10 * * 1')).toBe('weekly')
    expect(detectPreset('*/5 * * * *')).toBeNull()
    expect(detectPreset('0 8 * * 1#1')).toBeNull()
  })
})

describe('formatters', () => {
  const now = Date.UTC(2026, 8, 16, 8, 0)

  it('countdowns stay human', () => {
    expect(fmtCountdown(now + 5_000, now)).toBe('5 秒后')
    expect(fmtCountdown(now + 5 * MINUTE, now)).toBe('5 分钟后')
    expect(fmtCountdown(now + 3 * HOUR + 5 * MINUTE, now)).toBe('3 小时 5 分后')
    expect(fmtCountdown(now - 1, now)).toBe('即将触发')
  })

  it('durations clamp and cascade', () => {
    expect(fmtDuration(500)).toBe('500ms')
    expect(fmtDuration(42_000)).toBe('42s')
    expect(fmtDuration(94_000)).toBe('1m 34s')
    expect(fmtDuration(3 * HOUR)).toBe('3h 00m')
    expect(fmtDuration(Number.NaN)).toBe('—')
  })

  it('prefills a one-year RFC 3339 window with numeric offset', () => {
    const value = oneYearOutRfc3339(now)
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00[+-]\d{2}:\d{2}$/)
    expect(Number.isNaN(Date.parse(value))).toBe(false)
  })
})
