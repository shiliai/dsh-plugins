/**
 * Pure display formatting for the cron panel: countdowns, durations, schedule
 * lines, status labels. Unit-tested without a DOM.
 * @module @dsh-plugins/dsh-cron/client/format
 */

import type { ClientJob, RunStatus } from './types.ts'

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** "3 天 2 小时后" / "5 分钟后" / "即将触发". */
export function fmtCountdown(targetMs: number, nowMs: number): string {
  const diff = targetMs - nowMs
  if (diff <= 0) return '即将触发'
  const minutes = Math.floor(diff / MINUTE)
  if (minutes < 1) return `${Math.floor(diff / 1000)} 秒后`
  if (minutes < 60) return `${minutes} 分钟后`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分后`
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时后`
}

/** "2m 34s" / "1h 05m" / "42s". */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`
}

/** "9/16 08:00" — compact list timestamp. */
export function fmtDateTime(ms: number): string {
  const date = new Date(ms)
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function fmtClock(ms: number): string {
  const date = new Date(ms)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export const STATUS_LABEL: Record<RunStatus, string> = {
  ok: 'ok',
  failed: 'failed',
  running: 'running',
  killed: 'killed',
  aborted: 'aborted',
  timeout: 'timeout',
  skipped: 'skipped',
}

/** Status dot class for a job row: running > paused/archived > last run status. */
export function statusDotClass(view: { job: ClientJob; running: unknown | null; runs: Array<{ status: RunStatus }> }): string {
  if (view.running !== null) return 'running'
  if (view.job.archivedAt !== undefined) return 'paused'
  if (!view.job.enabled) return 'paused'
  const last = view.runs[0]
  if (last === undefined) return 'idle'
  if (last.status === 'ok') return 'ok'
  if (last.status === 'failed' || last.status === 'timeout') return 'failed'
  if (last.status === 'killed' || last.status === 'aborted') return 'killed'
  return 'idle'
}

export function scheduleText(job: ClientJob): string {
  const trigger = job.trigger
  if (trigger.kind === 'cron') return trigger.expr ?? ''
  if (trigger.kind === 'interval') {
    const seconds = trigger.everySeconds ?? 60
    if (seconds % 3600 === 0) return `每 ${seconds / 3600}h`
    if (seconds % 60 === 0) return `每 ${seconds / 60}min`
    return `每 ${seconds}s`
  }
  return trigger.at ?? '一次性'
}

export const KIND_LABEL: Record<TaskKindForLabel, string> = {
  agent: 'agent',
  command: 'cmd',
  callback: 'callback',
}

type TaskKindForLabel = 'agent' | 'command' | 'callback'

export const SOURCE_LABEL: Record<JobSourceLabel, string> = {
  manual: 'manual',
  config: 'config',
  plugin: 'plugin',
}

type JobSourceLabel = 'manual' | 'config' | 'plugin'

/** Preset cron expression builders for the modal's quick segments. */
export function presetExpr(preset: 'hourly' | 'daily' | 'weekdays' | 'weekly', hour: number, minute: number): string {
  const h = Math.min(23, Math.max(0, Math.floor(hour)))
  const m = Math.min(59, Math.max(0, Math.floor(minute)))
  switch (preset) {
    case 'hourly': return `${m} * * * *`
    case 'daily': return `${m} ${h} * * *`
    case 'weekdays': return `${m} ${h} * * 1-5`
    case 'weekly': return `${m} ${h} * * 1`
  }
}

/** Reverse-detect a quick preset from an expression; null when custom. */
export function detectPreset(expr: string): 'hourly' | 'daily' | 'weekdays' | 'weekly' | null {
  const match = expr.trim().match(/^(\d{1,2}) (\*|\d{1,2}) \* \* (\*|1-5|1)$/)
  if (match === null) return null
  const hour = match[2]
  const dow = match[3]
  if (hour === '*') return dow === '*' ? 'hourly' : null
  if (dow === '1-5') return 'weekdays'
  if (dow === '1') return 'weekly'
  return 'daily'
}

/** RFC 3339 with local offset, used as the prefilled default validity window. */
export function oneYearOutRfc3339(nowMs: number): string {
  const target = new Date(nowMs + 365 * DAY - HOUR)
  const offsetMinutes = -target.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  const hh = pad(Math.floor(abs / 60))
  const mm = pad(abs % 60)
  return `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}T${pad(target.getHours())}:${pad(target.getMinutes())}:00${sign}${hh}:${mm}`
}

export { MINUTE, HOUR, DAY }
