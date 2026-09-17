/**
 * Plugin config normalization. Values come from the cordis patch `config:`
 * block; every key is optional with a safe default. Reserved-name discipline
 * per AGENTS.md: no `DSH_`-prefixed env indirection here — plugin-owned
 * knobs live in the profile config, never in `.env`.
 * @module @dsh-plugins/dsh-cron/config
 */

import type { CronConfig } from './types.ts'

export interface NormalizedCronConfig {
  historyLimit: number
  tickIntervalMs: number
  maxConcurrentRuns: number
  sessionGc: { enabled: false; graceMinutes: number }
}

export function normalizeCronConfig(config: CronConfig | undefined): NormalizedCronConfig {
  const historyLimit = clampInt(config?.historyLimit, 1, 1000, 50)
  const tickIntervalMs = clampInt(config?.tickIntervalMs, 1_000, 15 * 60_000, 15_000)
  const maxConcurrentRuns = clampInt(config?.maxConcurrentRuns, 0, 256, 0)
  // v1.0 keeps session GC off (see types.ts CronConfig note); the key is
  // accepted so a forward profile config does not fail the mount.
  const graceMinutes = clampInt(config?.sessionGc?.graceMinutes, 1, 60 * 24 * 30, 30)
  return { historyLimit, tickIntervalMs, maxConcurrentRuns, sessionGc: { enabled: false, graceMinutes } }
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}
