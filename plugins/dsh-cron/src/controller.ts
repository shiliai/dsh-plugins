/**
 * Business operations shared by the HTTP API and the cron_* tools: manual job
 * CRUD, enable/disable, run-now, stop. Source discipline lives here — manual
 * jobs are the only editable/deletable kind; config/plugin jobs may only be
 * run, paused, and viewed (orphans may be deleted).
 * @module @dsh-plugins/dsh-cron/controller
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { CronScheduler } from './scheduler.ts'
import type { CronStore } from './store.ts'
import type { CronJob, JobView } from './types.ts'
import { normalizeJobSpec, ValidationError, type RawJobSpec } from './validate.ts'

export interface ControllerDeps {
  ctx: Context
  store: CronStore
  scheduler: CronScheduler
  historyLimit: number
  info(message: string): void
}

export interface JobOpResult {
  ok: boolean
  job?: JobView | undefined
  error?: string | undefined
  field?: string | undefined
}

export class CronController {
  constructor(private readonly deps: ControllerDeps) {}

  get scheduler(): CronScheduler {
    return this.deps.scheduler
  }

  /** All jobs with derived views (next fire, running state, run history). */
  state(): { serverTimeMs: number; tickIntervalMs: number; jobs: JobView[] } {
    return this.deps.scheduler.view()
  }

  jobView(id: string): JobView | undefined {
    return this.deps.scheduler.view().jobs.find(view => view.job.id === id)
  }

  /** Create a manual job from a raw payload (Web UI or cron_create tool). */
  async createManualJob(raw: RawJobSpec): Promise<JobOpResult> {
    try {
      const spec = normalizeJobSpec(raw, Date.now())
      const existing = this.deps.store.findByName(spec.name)
      if (existing !== undefined) {
        return { ok: false, error: `同名任务已存在:${spec.name}(${existing.source})`, field: 'name' }
      }
      const now = Date.now()
      const job: CronJob = {
        id: `cron-${randomUUID().slice(0, 8)}`,
        ...spec,
        source: 'manual',
        enabled: true,
        createdAt: now,
        updatedAt: now,
        seq: 0,
        ...(spec.trigger.kind === 'interval' ? { anchorMs: now } : {}),
      }
      await this.deps.store.putJob(job)
      this.deps.info(`job created: ${job.name} (${job.id})`)
      return { ok: true, job: this.jobView(job.id) }
    } catch (error) {
      return this.errorResult(error)
    }
  }

  /** Update a manual job; runtime fields (seq, lastFiredMs, anchor) survive. */
  async updateManualJob(id: string, raw: RawJobSpec): Promise<JobOpResult> {
    try {
      const existing = this.deps.store.getJob(id)
      if (existing === undefined) return { ok: false, error: '任务不存在' }
      if (existing.source !== 'manual') return { ok: false, error: `来源为 ${existing.source} 的任务不可编辑` }
      if (this.deps.scheduler.runningOf(id) !== null) return { ok: false, error: '运行进行中,稍后再编辑' }
      const spec = normalizeJobSpec(raw, Date.now())
      if (spec.name !== existing.name && this.deps.store.findByName(spec.name) !== undefined) {
        return { ok: false, error: `同名任务已存在:${spec.name}`, field: 'name' }
      }
      const updated: CronJob = {
        ...existing,
        ...spec,
        // Keep the interval anchor so beats stay aligned across edits.
        ...(existing.anchorMs !== undefined ? { anchorMs: existing.anchorMs } : {}),
        updatedAt: Date.now(),
      }
      await this.deps.store.putJob(updated)
      this.deps.info(`job updated: ${updated.name} (${updated.id})`)
      return { ok: true, job: this.jobView(id) }
    } catch (error) {
      return this.errorResult(error)
    }
  }

  async setEnabled(id: string, enabled: boolean): Promise<JobOpResult> {
    const existing = this.deps.store.getJob(id)
    if (existing === undefined) return { ok: false, error: '任务不存在' }
    if (existing.archivedAt !== undefined) return { ok: false, error: '任务已归档' }
    existing.enabled = enabled
    existing.updatedAt = Date.now()
    await this.deps.store.putJob(existing)
    this.deps.info(`job ${enabled ? 'enabled' : 'disabled'}: ${existing.name}`)
    return { ok: true, job: this.jobView(id) }
  }

  async removeJob(id: string): Promise<JobOpResult> {
    const existing = this.deps.store.getJob(id)
    if (existing === undefined) return { ok: false, error: '任务不存在' }
    if (existing.source === 'manual' || existing.source === 'plugin') {
      if (this.deps.scheduler.runningOf(id) !== null) return { ok: false, error: '运行进行中,先停止再删除' }
    }
    if (existing.source === 'config') return { ok: false, error: 'config 声明的任务不可删除,请在 profile 配置中移除' }
    await this.deps.store.deleteJob(id)
    this.deps.info(`job removed: ${existing.name} (含全部运行历史)`)
    return { ok: true }
  }

  async runNow(id: string): Promise<JobOpResult> {
    const result = await this.deps.scheduler.runNow(id)
    return result.ok ? { ok: true, job: this.jobView(id) } : { ok: false, error: result.error }
  }

  async stopRun(id: string): Promise<JobOpResult> {
    const stopped = this.deps.scheduler.stopRun(id)
    if (!stopped.ok) return { ok: false, error: stopped.error }
    await this.deps.scheduler.markStopped(id)
    return { ok: true, job: this.jobView(id) }
  }

  runHistory(id: string): { ok: boolean; runs?: import('./types.ts').CronRun[]; error?: string } {
    const existing = this.deps.store.getJob(id)
    if (existing === undefined) return { ok: false, error: '任务不存在' }
    return { ok: true, runs: this.deps.store.listRuns(id, this.deps.historyLimit) }
  }

  private errorResult(error: unknown): JobOpResult {
    if (error instanceof ValidationError) return { ok: false, error: error.message, field: error.field }
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
