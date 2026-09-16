/**
 * The scheduler: a wall-clock-resampling tick loop (clock discipline comes
 * from re-reading the clock on every wake, never from trusting a computed
 * deadline), at-most-once firing (lastFiredMs is durable before execution),
 * misfire skip/runOnce, overlap skip/queue/replace, a global concurrency cap,
 * and window expiry archiving.
 * @module @dsh-plugins/dsh-cron/scheduler
 */

import type { Context } from '@deepseek-ai/cordis'
import { runAgentTask } from './agent-runner.ts'
import { runCommand, runDelivery } from './command-runner.ts'
import { isStaleBeat, lastDueBeat, nextFire, windowEndMs } from './schedule.ts'
import type { CronStore } from './store.ts'
import type { CronConfig, CronJob, CronRun, CronStateView, JobView, RunningRun } from './types.ts'

export interface SchedulerDeps {
  ctx: Context
  store: CronStore
  config: Required<Pick<CronConfig, 'historyLimit' | 'tickIntervalMs' | 'maxConcurrentRuns'>>
  warn(message: string): void
  info(message: string): void
  /** Fired after any state change so the Web UI can refresh promptly. */
  notify?: () => void
}

interface LiveRun {
  run: CronRun
  controller: AbortController
}

export class CronScheduler {
  private readonly live = new Map<string, LiveRun>()
  private readonly queuedBeats = new Map<string, number>()
  private timer: ReturnType<typeof setInterval> | undefined
  private ticking = false
  private disposed = false

  constructor(private readonly deps: SchedulerDeps) {}

  get runningCount(): number {
    return this.live.size
  }

  start(): void {
    const period = Math.max(1_000, this.deps.config.tickIntervalMs)
    this.timer = setInterval(() => {
      void this.tick()
    }, period)
    this.timer.unref?.()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.timer !== undefined) clearInterval(this.timer)
    // Stop every live run; each record settles as aborted through its runner.
    for (const live of this.live.values()) live.controller.abort()
    const pending = [...this.live.values()].map(live => live.controller.signal)
    if (pending.length > 0) {
      // Give runners a moment to persist their aborted records.
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }

  /** One scheduling pass. Re-entrant calls are dropped, never queued. */
  async tick(nowMs: number = Date.now()): Promise<void> {
    if (this.ticking || this.disposed) return
    this.ticking = true
    try {
      for (const job of this.deps.store.listJobs()) {
        if (this.disposed) return
        await this.processJob(job, nowMs)
      }
    } finally {
      this.ticking = false
    }
  }

  private async processJob(job: CronJob, nowMs: number): Promise<void> {
    // Window expiry archives the job (loops) — one-shot archive happens after firing.
    const windowEnd = windowEndMs(job)
    if (job.trigger.kind !== 'oneshot' && windowEnd !== null && nowMs >= windowEnd && job.archivedAt === undefined) {
      await this.archive(job, nowMs, '有效期窗口已到期,自动归档')
      return
    }
    if (!job.enabled || job.archivedAt !== undefined) return

    const due = lastDueBeat(job, job.lastFiredMs ?? Number.NEGATIVE_INFINITY, nowMs)
    if (due === null) return
    if (due <= (job.lastFiredMs ?? Number.NEGATIVE_INFINITY)) return

    // at-most-once: consume the beat durably BEFORE executing.
    job.lastFiredMs = due
    job.updatedAt = nowMs
    await this.deps.store.putJob(job)

    if (isStaleBeat(due, nowMs, this.deps.config.tickIntervalMs)) {
      await this.handleStale(job, due)
      return
    }
    await this.startOrApplyOverlap(job, due)
  }

  /** Restart-era beats: skip by default, or run the most recent one once. */
  private async handleStale(job: CronJob, due: number): Promise<void> {
    if (job.trigger.kind === 'oneshot') {
      // A one-shot past its moment: skip archives it, runOnce fires it late.
      if (job.misfire === 'skip') {
        await this.archive(job, Date.now(), '一次性时刻已过期(misfire=skip),归档不补跑')
        return
      }
    } else if (job.misfire === 'skip') {
      await this.recordSkipped(job, due, '错过节拍(misfire=skip,不补跑)')
      return
    }
    this.deps.info(`misfire runOnce: ${job.name} @ ${new Date(due).toISOString()}`)
    await this.startOrApplyOverlap(job, due)
  }

  private async startOrApplyOverlap(job: CronJob, due: number): Promise<void> {
    const live = this.live.get(job.id)
    if (live !== undefined) {
      if (job.overlap === 'skip') {
        await this.recordSkipped(job, due, '上一轮仍在运行,本次跳过(overlap=skip)')
        return
      }
      if (job.overlap === 'queue') {
        // Depth 1: only the most recent crowded-out beat is kept.
        this.queuedBeats.set(job.id, due)
        await this.recordSkipped(job, due, '上一轮仍在运行,已排队一次(overlap=queue)')
        return
      }
      // replace: stop the live run; it settles as killed, then this beat starts.
      live.controller.abort()
      this.live.delete(job.id)
    }
    if (!this.reserveConcurrency()) {
      await this.recordSkipped(job, due, '已达全局并发上限,本次跳过')
      return
    }
    await this.launch(job, due)
  }

  private reserveConcurrency(): boolean {
    const max = this.deps.config.maxConcurrentRuns
    if (max <= 0) return true
    return this.live.size < max
  }

  private async launch(job: CronJob, due: number): Promise<void> {
    const seq = job.seq + 1
    const startedAt = Date.now()
    const run: CronRun = {
      jobId: job.id,
      seq,
      targetMs: due,
      startedAt,
      status: 'running',
    }
    const controller = new AbortController()
    this.live.set(job.id, { run, controller })
    job.seq = seq
    await this.deps.store.putJob(job)
    await this.deps.store.putRun(run, this.deps.config.historyLimit)
    this.deps.notify?.()
    void this.execute(job, run, controller).finally(() => {
      this.live.delete(job.id)
      void this.drainQueue(job)
    })
  }

  /** When a live run finishes, start the queued beat (overlap=queue, depth 1). */
  private async drainQueue(job: CronJob): Promise<void> {
    const queued = this.queuedBeats.get(job.id)
    if (queued === undefined || this.disposed || this.live.has(job.id)) return
    this.queuedBeats.delete(job.id)
    const fresh = this.deps.store.getJob(job.id)
    if (fresh === undefined || !fresh.enabled || fresh.archivedAt !== undefined || fresh.overlap !== 'queue') return
    if (!this.reserveConcurrency()) return
    await this.launch(fresh, queued)
  }

  private async execute(job: CronJob, run: CronRun, controller: AbortController): Promise<void> {
    const timeoutMs = (job.timeoutSeconds ?? 600) * 1000
    let patch: Partial<CronRun>
    try {
      if (job.task.kind === 'agent') {
        const outcome = await runAgentTask(this.deps.ctx, job, job.task.prompt, run.targetMs, timeoutMs, controller.signal)
        patch = {
          finishedAt: Date.now(),
          status: outcome.ok ? 'ok' : outcome.timedOut === true ? 'timeout' : outcome.aborted === true ? 'killed' : 'failed',
          summary: outcome.summary,
          sessionId: outcome.sessionId,
          ...(outcome.error ? { error: outcome.error } : {}),
        }
      } else {
        const outcome = await runCommand(job.task.argv, { ...(job.cwd !== undefined ? { cwd: job.cwd } : {}), timeoutMs, signal: controller.signal })
        patch = {
          finishedAt: Date.now(),
          status: outcome.ok ? 'ok' : outcome.timedOut === true ? 'timeout' : outcome.aborted === true ? 'killed' : 'failed',
          summary: outcome.ok ? `退出码 0` : (outcome.error ?? '命令失败'),
          exitCode: outcome.exitCode ?? -1,
          outputTail: outcome.outputTail,
          argv: job.task.argv,
          ...(outcome.error ? { error: outcome.error } : {}),
        }
      }
    } catch (error) {
      patch = {
        finishedAt: Date.now(),
        status: 'failed',
        summary: '执行异常',
        error: error instanceof Error ? error.message : String(error),
      }
    }
    // Delivery (v1.0: command). Default fires only on failure.
    const delivery = job.delivery
    if (delivery !== undefined && delivery.kind === 'command' && !(delivery.onFailureOnly !== false && patch.status === 'ok')) {
      const recordJson = JSON.stringify({ job: publicJob(job), run: { ...run, ...patch } }, null, 2)
      const outcome = await runDelivery(delivery, recordJson, job.cwd)
      patch.delivery = outcome
      if (outcome.exitCode !== 0 && patch.error === undefined) {
        patch.error = `delivery 退出码 ${outcome.exitCode}`
      }
    }
    // A user stop may already have written a killed record; keep the newest.
    const existing = this.deps.store.getRun(run.jobId, run.seq)
    if (existing !== undefined && existing.status !== 'running') {
      await this.finalize(job, existing)
      return
    }
    const updated = await this.deps.store.updateRun(run.jobId, run.seq, patch)
    await this.finalize(job, updated ?? { ...run, ...patch })
  }

  /** One-shot self-archive after firing; notify listeners. */
  private async finalize(job: CronJob, run: CronRun): Promise<void> {
    if (job.trigger.kind === 'oneshot' && run.status !== 'running') {
      const fresh = this.deps.store.getJob(job.id)
      if (fresh !== undefined && fresh.archivedAt === undefined) {
        fresh.archivedAt = Date.now()
        fresh.updatedAt = Date.now()
        await this.deps.store.putJob(fresh)
      }
    }
    this.deps.notify?.()
  }

  private async archive(job: CronJob, nowMs: number, reason: string): Promise<void> {
    const fresh = this.deps.store.getJob(job.id) ?? job
    fresh.archivedAt = nowMs
    fresh.enabled = false
    fresh.updatedAt = nowMs
    await this.deps.store.putJob(fresh)
    this.deps.info(`${job.name} archived: ${reason}`)
    this.deps.notify?.()
  }

  private async recordSkipped(job: CronJob, targetMs: number, reason: string): Promise<void> {
    const seq = job.seq + 1
    job.seq = seq
    await this.deps.store.putJob(job)
    await this.deps.store.putRun({
      jobId: job.id,
      seq,
      targetMs,
      startedAt: targetMs,
      finishedAt: targetMs,
      status: 'skipped',
      summary: reason,
    }, this.deps.config.historyLimit)
    this.deps.notify?.()
  }

  /** Manual run-now: fires immediately regardless of schedule (consume no beat). */
  async runNow(jobId: string): Promise<{ ok: boolean; error?: string }> {
    const job = this.deps.store.getJob(jobId)
    if (job === undefined) return { ok: false, error: '任务不存在' }
    if (job.archivedAt !== undefined) return { ok: false, error: '任务已归档' }
    if (this.live.has(jobId)) return { ok: false, error: '已有运行在进行中' }
    if (!this.reserveConcurrency()) return { ok: false, error: '已达全局并发上限' }
    await this.launch(job, Date.now())
    return { ok: true }
  }

  /** Manual stop of the current live run. */
  stopRun(jobId: string): { ok: boolean; error?: string } {
    const live = this.live.get(jobId)
    if (live === undefined) return { ok: false, error: '没有进行中的运行' }
    this.live.delete(jobId)
    live.controller.abort()
    return { ok: true }
  }

  runningOf(jobId: string): RunningRun | null {
    const live = this.live.get(jobId)
    if (live === undefined) return null
    return { jobId: live.run.jobId, seq: live.run.seq, targetMs: live.run.targetMs, startedAt: live.run.startedAt }
  }

  /** Persisted killed record for a user-stopped run. */
  async markStopped(jobId: string): Promise<void> {
    const liveSeq = this.deps.store.getJob(jobId)?.seq
    if (liveSeq === undefined) return
    const existing = this.deps.store.getRun(jobId, liveSeq)
    if (existing === undefined || existing.status !== 'running') return
    await this.deps.store.updateRun(jobId, liveSeq, {
      finishedAt: Date.now(),
      status: 'killed',
      summary: existing.summary ?? '用户手动停止',
      stoppedBy: 'user',
    })
    this.deps.notify?.()
  }

  /** State projection for the Web UI and tools. */
  view(jobLimit?: number): CronStateView {
    const jobs = this.deps.store.listJobs()
    const views: JobView[] = jobs.map(job => ({
      job,
      nextFireMs: nextFire(job, Date.now()),
      running: this.runningOf(job.id),
      queuedBeatMs: this.queuedBeats.get(job.id) ?? null,
      runs: this.deps.store.listRuns(job.id, jobLimit),
    }))
    return {
      serverTimeMs: Date.now(),
      tickIntervalMs: this.deps.config.tickIntervalMs,
      jobs: views,
    }
  }
}

export function publicJob(job: CronJob): CronJob {
  return { ...job }
}
