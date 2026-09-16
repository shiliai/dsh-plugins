/**
 * Durable state for dsh-cron. Jobs and runs live in the `cron` storage domain
 * (schema-validated KV tables, atomic per write, never the session journal).
 * When the host has no storage-domain facility (rare headless compositions)
 * the store degrades to in-memory with a loud warning: scheduling keeps
 * working while the process lives, but nothing survives a restart.
 * @module @dsh-plugins/dsh-cron/store
 */

import { z } from 'zod'
import type { CronJob, CronRun } from './types.ts'

/** Structural face of the host's storage-domain facility (duck-typed on purpose). */
export interface DomainFacilityLike {
  open(spec: unknown): Promise<DomainLike>
}

export interface KvTableLike<V = unknown> {
  get(key: string): V | undefined
  entries(): IterableIterator<[string, V]>
  put(key: string, value: V): Promise<void>
  delete(key: string): Promise<boolean>
}

export interface DomainLike {
  table(name: string): KvTableLike
  close(): Promise<void>
}

export interface StorageLike {
  domain?: DomainFacilityLike
}

/** Loose records: validation guards present fields, forward-compat keeps the rest. */
const jobSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  source: z.enum(['manual', 'config', 'plugin']),
  trigger: z.object({ kind: z.string() }).passthrough(),
  task: z.object({ kind: z.string() }).passthrough(),
  enabled: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
  seq: z.number(),
})

const runSchema = z.looseObject({
  jobId: z.string().min(1),
  seq: z.number(),
  targetMs: z.number(),
  startedAt: z.number(),
  status: z.enum(['ok', 'failed', 'running', 'killed', 'aborted', 'timeout', 'skipped']),
})

export const CRON_DOMAIN_SPEC = {
  name: 'cron',
  version: 1,
  tables: {
    jobs: { valueSchema: jobSchema },
    runs: { valueSchema: runSchema },
  },
}

export class CronStore {
  private readonly jobs: KvTableLike<CronJob>
  private readonly runs: KvTableLike<CronRun>
  readonly persistent: boolean

  private constructor(jobs: KvTableLike<CronJob>, runs: KvTableLike<CronRun>, persistent: boolean) {
    this.jobs = jobs
    this.runs = runs
    this.persistent = persistent
  }

  /** Open the `cron` domain, falling back to memory when the facility is absent. */
  static async open(storage: StorageLike | undefined, warn: (message: string) => void): Promise<CronStore> {
    const facility = storage?.domain
    if (facility === undefined || typeof facility.open !== 'function') {
      warn('storage domain facility unavailable; dsh-cron state is IN-MEMORY ONLY and will not survive a restart')
      return new CronStore(new MemoryTable(), new MemoryTable(), false)
    }
    const domain = await facility.open(CRON_DOMAIN_SPEC)
    return new CronStore(domain.table('jobs') as KvTableLike<CronJob>, domain.table('runs') as KvTableLike<CronRun>, true)
  }

  listJobs(): CronJob[] {
    return Array.from(this.jobs.entries(), ([, job]) => job).sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name))
  }

  getJob(id: string): CronJob | undefined {
    return this.jobs.get(id)
  }

  findByName(name: string): CronJob | undefined {
    return this.listJobs().find(job => job.name === name)
  }

  async putJob(job: CronJob): Promise<void> {
    await this.jobs.put(job.id, job)
  }

  async deleteJob(id: string): Promise<boolean> {
    const runKeys = this.runKeysFor(id)
    for (const key of runKeys) await this.runs.delete(key)
    return this.jobs.delete(id)
  }

  listRuns(jobId: string, limit?: number): CronRun[] {
    const prefix = `${jobId}#`
    const all = Array.from(this.runs.entries(), ([, run]) => run)
      .filter(run => `${run.jobId}#${run.seq}`.startsWith(prefix))
      .sort((a, b) => b.seq - a.seq)
    return limit === undefined ? all : all.slice(0, limit)
  }

  getRun(jobId: string, seq: number): CronRun | undefined {
    return this.runs.get(runKey(jobId, seq))
  }

  async putRun(run: CronRun, historyLimit: number): Promise<void> {
    await this.runs.put(runKey(run.jobId, run.seq), run)
    const all = this.listRuns(run.jobId)
    for (const stale of all.slice(historyLimit)) {
      await this.runs.delete(runKey(stale.jobId, stale.seq))
    }
  }

  async updateRun(jobId: string, seq: number, patch: Partial<Omit<CronRun, 'jobId' | 'seq'>>): Promise<CronRun | undefined> {
    const existing = this.getRun(jobId, seq)
    if (existing === undefined) return undefined
    const updated: CronRun = { ...existing, ...patch }
    await this.runs.put(runKey(jobId, seq), updated)
    return updated
  }

  /** Boot-time crash repair: every record left `running` becomes `aborted`. */
  async repairInterrupted(): Promise<number> {
    let repaired = 0
    for (const [, run] of Array.from(this.runs.entries())) {
      if (run.status !== 'running') continue
      await this.runs.put(runKey(run.jobId, run.seq), {
        ...run,
        status: 'aborted',
        finishedAt: run.finishedAt ?? Date.now(),
        summary: run.summary ?? '进程中断,启动时修复为 aborted',
      })
      repaired++
    }
    return repaired
  }

  private runKeysFor(jobId: string): string[] {
    const prefix = `${jobId}#`
    return Array.from(this.runs.entries(), ([key]) => key).filter(key => key.startsWith(prefix))
  }
}

function runKey(jobId: string, seq: number): string {
  return `${jobId}#${seq}`
}

class MemoryTable<V = unknown> implements KvTableLike<V> {
  private readonly map = new Map<string, V>()

  get(key: string): V | undefined {
    return this.map.get(key)
  }

  entries(): IterableIterator<[string, V]> {
    return this.map.entries()
  }

  async put(key: string, value: V): Promise<void> {
    this.map.set(key, value)
  }

  async delete(key: string): Promise<boolean> {
    return this.map.delete(key)
  }
}
