/**
 * Append-only JSONL routing stats. Writes are best-effort: a stats failure
 * must never fail a delegation.
 * @module @dsh-plugins/dsh-agent-team/stats
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface StatsRecord {
  ts: string
  task: string
  verdict?: { complexity: number; executor: string; confidence: number }
  decision: 'leader' | 'worker' | 'fallback-leader'
  worker?: string
  durationMs: number
  jevDurationMs?: number
  error?: string
}

type Warn = (message: string) => void

/**
 * Append one stats line, creating the directory on first use. `null` file
 * disables stats. Errors are reported through `warn` and swallowed.
 */
export async function appendStats(file: string | null, record: StatsRecord, warn: Warn = console.warn): Promise<void> {
  if (file === null) return
  try {
    await mkdir(dirname(file), { recursive: true })
    await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8')
  } catch (error) {
    warn(`dsh-agent-team: failed to append routing stats: ${String(error)}`)
  }
}
