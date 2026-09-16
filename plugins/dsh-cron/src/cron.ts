/**
 * 5-field cron parsing and next-fire computation against explicit IANA time
 * zones. Wall-clock fields are resolved through `Intl.DateTimeFormat`, so the
 * process time zone is never consulted; instants are always real UTC time, so
 * spring-forward gaps never fire and fall-back repeats pick the first instant.
 * @module @dsh-plugins/dsh-cron/cron
 */



export interface CronFields {
  minutes: Set<number>
  hours: Set<number>
  daysOfMonth: Set<number>
  months: Set<number>
  daysOfWeek: Set<number>
  domStar: boolean
  dowStar: boolean
}

const DAY_NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
const MONTH_NAMES: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }

function parseField(field: string, min: number, max: number, names?: Record<string, number>): Set<number> {
  const values = new Set<number>()
  for (const rawPart of field.toLowerCase().split(',')) {
    const part = rawPart.trim()
    if (part.length === 0) throw new Error(`empty cron field segment in "${field}"`)
    let step = 1
    let range = part
    const slash = part.indexOf('/')
    if (slash >= 0) {
      step = Number.parseInt(part.slice(slash + 1), 10)
      range = part.slice(0, slash)
      if (!Number.isInteger(step) || step < 1) throw new Error(`invalid step in cron field "${field}"`)
    }
    let low: number
    let high: number
    if (range === '*') {
      low = min
      high = max
    } else if (range === '') {
      // "*/n" leaves an empty range part.
      low = min
      high = max
    } else if (range.includes('-')) {
      const bounds = range.split('-')
      const rawLow = bounds[0]
      const rawHigh = bounds[1]
      if (rawLow === undefined || rawHigh === undefined) throw new Error(`cron field "${field}" has a malformed range`)
      low = names?.[rawLow] ?? parseOrdinal(rawLow, field)
      high = names?.[rawHigh] ?? parseOrdinal(rawHigh, field)
    } else {
      low = names?.[range] ?? parseOrdinal(range, field)
      high = slash >= 0 ? max : low
    }
    if (!Number.isInteger(low) || !Number.isInteger(high) || low < min || high > max || low > high) {
      throw new Error(`cron field "${field}" is out of range (${min}-${max})`)
    }
    for (let value = low; value <= high; value += step) values.add(value)
  }
  return values
}

function parseOrdinal(raw: string, field: string): number {
  const value = Number.parseInt(raw, 10)
  if (!Number.isInteger(value)) throw new Error(`cron field "${field}" has a non-numeric value "${raw}"`)
  return value
}

export function parseCron(expr: string): CronFields {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error('cron 表达式需要 5 个字段:分 时 日 月 周')
  const [minute, hour, dom, mon, dow] = fields as [string, string, string, string, string]
  const daysOfMonth = parseField(dom, 1, 31)
  const daysOfWeek = parseField(dow, 0, 6, DAY_NAMES)
  return {
    minutes: parseField(minute, 0, 59),
    hours: parseField(hour, 0, 23),
    daysOfMonth,
    months: parseField(mon, 1, 12, MONTH_NAMES),
    daysOfWeek,
    domStar: dom.trim() === '*',
    dowStar: dow.trim() === '*',
  }
}

export interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  weekday: number
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>()

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatterCache.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    })
    partsFormatterCache.set(timeZone, formatter)
  }
  return formatter
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/** Wall-clock fields of a UTC instant in `timeZone`. */
export function zonedParts(ms: number, timeZone: string): ZonedParts {
  const parts = partsFormatter(timeZone).formatToParts(new Date(ms))
  const get = (type: string): string => parts.find(part => part.type === type)?.value ?? ''
  const hour = Number.parseInt(get('hour'), 10)
  return {
    year: Number.parseInt(get('year'), 10),
    month: Number.parseInt(get('month'), 10),
    day: Number.parseInt(get('day'), 10),
    // Some ICU builds render midnight as "24".
    hour: hour === 24 ? 0 : hour,
    minute: Number.parseInt(get('minute'), 10),
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
  }
}

function matches(fields: CronFields, parts: ZonedParts): boolean {
  const domOk = fields.daysOfMonth.has(parts.day)
  const dowOk = fields.daysOfWeek.has(parts.weekday)
  // Vixie semantics: when both day fields are restricted either may match.
  const dayOk = (fields.domStar || fields.dowStar) ? (domOk && dowOk) : (domOk || dowOk)
  return fields.months.has(parts.month) && dayOk && fields.hours.has(parts.hour) && fields.minutes.has(parts.minute)
}

/**
 * Next matching instant strictly after `fromMs`. Iterates real UTC instants
 * (minute resolution) with wall-clock jumps, so DST-nonexistent wall times are
 * skipped naturally and a year without any match throws.
 */
export function nextCronFire(expr: string, fromMs: number, timeZone: string): number {
  const fields = parseCron(expr)
  validateTimeZone(timeZone)
  let t = Math.floor(fromMs / 60_000) * 60_000 + 60_000
  const deadline = fromMs + 366 * 24 * 60 * 60_000
  let guard = 0
  while (t <= deadline) {
    if (++guard > 600_000) throw new Error('cron 下一次触发计算超出安全界限')
    const parts = zonedParts(t, timeZone)
    if (matches(fields, parts)) {
      // A matching wall clock can be ambiguous (fall-back): the earliest
      // instant wins, which is the first `t` we see. Nonexistent times never
      // appear because we scan real instants.
      return t
    }
    if (!fields.minutes.has(parts.minute)) {
      t += 60_000
      continue
    }
    if (!fields.hours.has(parts.hour)) {
      // Real-hour steps resynchronize across DST shifts.
      t = Math.floor((t + 60 * 60_000) / 60_000) * 60_000
      continue
    }
    // Minute and hour match but the day (or month) blocks: step hour by hour
    // to the next wall-clock midnight so DST-shortened days stay correct.
    let stepped = 0
    do {
      t = Math.floor((t + 60 * 60_000) / 60_000) * 60_000
      stepped++
    } while (stepped < 30 && zonedParts(t, timeZone).hour !== 0)
  }
  throw new Error('一年内没有匹配的 cron 触发时刻')
}

export function validateTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
  } catch {
    throw new Error(`非法 IANA 时区:"${timeZone}"`)
  }
}

/**
 * The latest cron beat in `(afterMs, atOrBeforeMs]`, or null. Iterates beats
 * forward from `afterMs`; cheap because ticks call it with a recent anchor.
 */
/** The latest cron beat in `(afterMs, atOrBeforeMs]`, or null. Iterates beats
 * forward from `afterMs`; cheap because ticks call it with a recent anchor.
 * The 50000-beat bound (~35 days of `* * * * *`) only matters after eons of
 * downtime, where the stale-beat rule makes the exact beat irrelevant. */
export function lastCronBeat(expr: string, afterMs: number, atOrBeforeMs: number, timeZone: string): number | null {
  let latest: number | null = null
  let cursor = afterMs
  for (let i = 0; i < 50_000; i++) {
    const next = nextCronFire(expr, cursor, timeZone)
    if (next > atOrBeforeMs) break
    latest = next
    cursor = next
  }
  return latest
}
