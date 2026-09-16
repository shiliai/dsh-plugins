/**
 * Trigger arithmetic shared by the scheduler and validation: next-fire
 * preview, latest-due-beat lookup, and the staleness rule that turns a beat
 * older than one tick into a misfire.
 * @module @dsh-plugins/dsh-cron/schedule
 */

import { lastCronBeat, nextCronFire } from './cron.ts'
import type { CronJob } from './types.ts'

/** Next fire strictly after `fromMs`, or null when the trigger is exhausted. */
export function nextFire(job: CronJob, fromMs: number): number | null {
  if (!job.enabled || job.archivedAt !== undefined) return null
  const windowEnd = windowEndMs(job)
  if (windowEnd !== null && fromMs >= windowEnd) return null
  const trigger = job.trigger
  if (trigger.kind === 'cron') {
    const next = nextCronFire(trigger.expr, fromMs, trigger.timeZone)
    return windowEnd !== null && next > windowEnd ? null : next
  }
  if (trigger.kind === 'interval') {
    const anchor = job.anchorMs ?? job.createdAt
    const step = Math.max(60, trigger.everySeconds) * 1000
    if (fromMs < anchor) return anchor
    const next = anchor + Math.ceil((fromMs - anchor + 1) / step) * step
    return windowEnd !== null && next > windowEnd ? null : next
  }
  const at = Date.parse(trigger.at)
  if (Number.isNaN(at) || at <= fromMs) return null
  return windowEnd !== null && at > windowEnd ? null : at
}

/** Latest due beat in `(afterMs, atOrBeforeMs]`, or null. */
export function lastDueBeat(job: CronJob, afterMs: number, atOrBeforeMs: number): number | null {
  if (!job.enabled || job.archivedAt !== undefined) return null
  const trigger = job.trigger
  if (trigger.kind === 'cron') return lastCronBeat(trigger.expr, afterMs, atOrBeforeMs, trigger.timeZone)
  if (trigger.kind === 'interval') {
    const anchor = job.anchorMs ?? job.createdAt
    const step = Math.max(60, trigger.everySeconds) * 1000
    if (atOrBeforeMs < anchor) return null
    // Latest anchor-aligned beat at or before `atOrBeforeMs`.
    const latest = anchor + Math.floor((atOrBeforeMs - anchor) / step) * step
    if (latest <= afterMs || latest > atOrBeforeMs) return null
    return latest
  }
  const at = Date.parse(trigger.at)
  if (Number.isNaN(at) || at <= afterMs || at > atOrBeforeMs) return null
  return at
}

/**
 * A due beat is stale — i.e. a genuine misfire rather than normal tick
 * latency — when the first tick that observes it is more than two tick
 * periods late (restarts, event-loop stalls, missed ticks).
 */
export function isStaleBeat(dueMs: number, nowMs: number, tickIntervalMs: number): boolean {
  return nowMs - dueMs > Math.max(tickIntervalMs * 2, 30_000)
}

export function windowEndMs(job: CronJob): number | null {
  const window = job.window
  if (window === undefined) return null
  if (window.endAt !== undefined) {
    const end = Date.parse(window.endAt)
    if (!Number.isNaN(end)) return end
  }
  if (window.maxDurationSeconds !== undefined) return job.createdAt + window.maxDurationSeconds * 1000
  return null
}

/** Human-readable schedule line for the job list and tools. */
export function scheduleText(job: CronJob): string {
  const trigger = job.trigger
  if (trigger.kind === 'cron') return `${trigger.expr} (${trigger.timeZone})`
  if (trigger.kind === 'interval') {
    const seconds = trigger.everySeconds
    if (seconds % 3600 === 0) return `每 ${seconds / 3600} 小时`
    if (seconds % 60 === 0) return `每 ${seconds / 60} 分钟`
    return `每 ${seconds} 秒`
  }
  return `一次性 @ ${trigger.at}`
}
