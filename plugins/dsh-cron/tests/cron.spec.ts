import { describe, expect, it } from 'vitest'
import { lastCronBeat, nextCronFire, parseCron, validateTimeZone, zonedParts } from '../src/cron.ts'

// Fixed-offset zone: Asia/Shanghai is +08:00 with no DST — good for exact math.
const SH = 'Asia/Shanghai'

function atSh(year: number, month: number, day: number, hour: number, minute: number): number {
  return Date.UTC(year, month - 1, day, hour - 8, minute)
}

describe('parseCron', () => {
  it('accepts 5-field expressions with ranges, steps, and names', () => {
    const fields = parseCron('0 9,15 * * 1-5')
    expect(fields.hours.has(9)).toBe(true)
    expect(fields.hours.has(15)).toBe(true)
    expect(fields.daysOfWeek.has(1)).toBe(true)
    expect(fields.daysOfWeek.has(5)).toBe(true)
    expect(fields.daysOfWeek.has(0)).toBe(false)
    const named = parseCron('0 0 * jan mon')
    expect(named.months.has(1)).toBe(true)
    expect(named.daysOfWeek.has(1)).toBe(true)
  })

  it('rejects wrong field counts and out-of-range values', () => {
    expect(() => parseCron('0 8 * *')).toThrow()
    expect(() => parseCron('0 8 * * * *')).toThrow()
    expect(() => parseCron('60 * * * *')).toThrow()
    expect(() => parseCron('* 24 * * *')).toThrow()
    expect(() => parseCron('* * 0 * *')).toThrow()
    expect(() => parseCron('*/0 * * * *')).toThrow()
  })
})

describe('validateTimeZone', () => {
  it('accepts IANA names and rejects junk', () => {
    expect(() => validateTimeZone(SH)).not.toThrow()
    expect(() => validateTimeZone('America/New_York')).not.toThrow()
    expect(() => validateTimeZone('Not/AZone')).toThrow()
  })
})

describe('nextCronFire', () => {
  it('computes the next daily fire in a fixed-offset zone', () => {
    const from = atSh(2026, 9, 16, 9, 0)
    const next = nextCronFire('0 8 * * *', from, SH)
    expect(next).toBe(atSh(2026, 9, 17, 8, 0))
  })

  it('fires later the same day when the wall time is still ahead', () => {
    const from = atSh(2026, 9, 16, 7, 30)
    expect(nextCronFire('0 8 * * *', from, SH)).toBe(atSh(2026, 9, 16, 8, 0))
  })

  it('returns strictly-later instants even when from is exactly a beat', () => {
    const beat = atSh(2026, 9, 16, 8, 0)
    expect(nextCronFire('0 8 * * *', beat, SH)).toBe(atSh(2026, 9, 17, 8, 0))
  })

  it('honors day-of-month and weekday restriction (weekdays)', () => {
    // 2026-09-16 is a Wednesday; 2026-09-19 Saturday → next fire Monday 09-21.
    const from = atSh(2026, 9, 16, 10, 0)
    expect(nextCronFire('0 9 * * 1-5', from, SH)).toBe(atSh(2026, 9, 17, 9, 0))
    const friday = atSh(2026, 9, 18, 10, 0)
    expect(nextCronFire('0 9 * * 1-5', friday, SH)).toBe(atSh(2026, 9, 21, 9, 0))
  })

  it('skips DST-nonexistent wall times (US spring forward 2026-03-08)', () => {
    const zone = 'America/New_York'
    const before = Date.UTC(2026, 2, 8, 0, 0) // 2026-03-07 19:00 EST
    // 02:30 local does not exist on 2026-03-08 (clocks jump 02:00→03:00 EST→EDT);
    // the next 02:30 wall time is 2026-03-09 02:30 EDT = 06:30 UTC.
    expect(nextCronFire('30 2 * * *', before, zone)).toBe(Date.UTC(2026, 2, 9, 6, 30))
  })

  it('uses Vixie semantics when both DOM and DOW are restricted', () => {
    // 2026-09-16 (Wed, 16th): `0 8 16 * 1` fires on the 16th OR Mondays.
    const from = atSh(2026, 9, 15, 12, 0)
    expect(nextCronFire('0 8 16 * 1', from, SH)).toBe(atSh(2026, 9, 16, 8, 0))
    // After the 16th, the next match is Monday 2026-09-21 (dom 16 passed, dow union).
    const after = atSh(2026, 9, 16, 12, 0)
    expect(nextCronFire('0 8 16 * 1', after, SH)).toBe(atSh(2026, 9, 21, 8, 0))
  })

  it('maps instants to the right wall clock', () => {
    const instant = atSh(2026, 9, 16, 8, 5)
    const parts = zonedParts(instant, SH)
    expect(parts).toMatchObject({ year: 2026, month: 9, day: 16, hour: 8, minute: 5 })
  })

  it('throws when a year cannot contain a match', () => {
    const from = atSh(2026, 9, 16, 0, 0)
    expect(() => nextCronFire('0 0 30 2 *', from, SH)).toThrow()
  })
})

describe('lastCronBeat', () => {
  it('finds the latest beat in the window', () => {
    const after = atSh(2026, 9, 15, 7, 0)
    const before = atSh(2026, 9, 16, 9, 0)
    expect(lastCronBeat('0 8 * * *', after, before, SH)).toBe(atSh(2026, 9, 16, 8, 0))
    expect(lastCronBeat('0 8 * * *', before, before, SH)).toBeNull()
  })

  it('finds every beat back-to-back for per-minute crons', () => {
    const after = atSh(2026, 9, 16, 8, 0)
    const before = atSh(2026, 9, 16, 8, 4)
    expect(lastCronBeat('* * * * *', after, before, SH)).toBe(atSh(2026, 9, 16, 8, 4))
  })
})
