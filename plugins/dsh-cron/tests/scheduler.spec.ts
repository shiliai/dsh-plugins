import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CronScheduler } from '../src/scheduler.ts'
import { CronStore } from '../src/store.ts'
import { normalizeCronConfig } from '../src/config.ts'
import type { CronJob } from '../src/types.ts'

const TICK = 15_000

interface World {
  store: CronStore
  scheduler: CronScheduler
  cleanup(): Promise<void>
}

async function makeWorld(maxConcurrentRuns = 0): Promise<World> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cron-test-'))
  const store = await CronStore.open(undefined, () => undefined) // in-memory fallback
  const scheduler = new CronScheduler({
    ctx: {} as never,
    store,
    config: { ...normalizeCronConfig(undefined), maxConcurrentRuns },
    warn: () => undefined,
    info: () => undefined,
  })
  return {
    store,
    scheduler,
    cleanup: async () => {
      await scheduler.dispose()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

function quickJob(overrides: Partial<CronJob> = {}): CronJob {
  const now = Date.now()
  return {
    id: `cron-${Math.random().toString(36).slice(2, 8)}`,
    name: 'quick',
    source: 'manual',
    trigger: { kind: 'interval', everySeconds: 3600 },
    task: { kind: 'command', argv: [process.execPath, '-e', 'process.exit(0)'] },
    overlap: 'skip',
    misfire: 'skip',
    enabled: true,
    anchorMs: now - 2_000,
    createdAt: now,
    updatedAt: now,
    seq: 0,
    ...overrides,
  }
}

describe('scheduler', () => {
  it('fires a due beat at-most-once: lastFiredMs advances and one run records', { timeout: 20_000 }, async () => {
    const world = await makeWorld()
    try {
      const job = quickJob({ anchorMs: Date.now() - 2_000 })
      await world.store.putJob(job)
      await world.scheduler.tick()
      expect(job.lastFiredMs).toBeDefined()
      expect(world.scheduler.runningOf(job.id)).not.toBeNull()
      await waitFor(() => world.store.listRuns(job.id)[0]?.status === 'ok')
      const run = world.store.listRuns(job.id)[0]!
      expect(run.exitCode).toBe(0)
      expect(run.summary).toContain('0')
    } finally {
      await world.cleanup()
    }
  })

  it('records a skipped run for stale beats under misfire=skip', { timeout: 20_000 }, async () => {
    const world = await makeWorld()
    try {
      // Anchor 1.5h ago with a 1h interval → the latest due beat is exactly
      // 30min old, deterministically stale (threshold ≈31s).
      const job = quickJob({ anchorMs: Date.now() - 5_400_000, trigger: { kind: 'interval', everySeconds: 3600 } })
      await world.store.putJob(job)
      await world.scheduler.tick()
      expect(job.lastFiredMs).toBeDefined()
      expect(world.scheduler.runningOf(job.id)).toBeNull()
      await waitFor(() => world.store.listRuns(job.id).length > 0)
      expect(world.store.listRuns(job.id)[0]!.status).toBe('skipped')
      expect(world.store.listRuns(job.id)[0]!.summary).toContain('skip')
    } finally {
      await world.cleanup()
    }
  })

  it('runOnce compensates the most recent stale beat', { timeout: 30_000 }, async () => {
    const world = await makeWorld()
    try {
      const job = quickJob({
        anchorMs: Date.now() - 5_400_000,
        trigger: { kind: 'interval', everySeconds: 3600 },
        misfire: 'runOnce',
        task: { kind: 'command', argv: [process.execPath, '-e', 'process.exit(0)'] },
      })
      await world.store.putJob(job)
      await world.scheduler.tick()
      await waitFor(() => world.store.listRuns(job.id)[0]?.status === 'ok', 20_000)
      expect(world.store.listRuns(job.id)).toHaveLength(1)
    } finally {
      await world.cleanup()
    }
  })

  it('overlap=skip records skipped-overlap while a run is live', { timeout: 30_000 }, async () => {
    const world = await makeWorld()
    try {
      const job = quickJob({
        anchorMs: Date.now() + 3_600_000, // no scheduled beat due
        task: { kind: 'command', argv: [process.execPath, '-e', 'await new Promise(r => setTimeout(r, 1500))'] },
      })
      await world.store.putJob(job)
      const started = await world.scheduler.runNow(job.id)
      expect(started.ok).toBe(true)
      // A beat coming due while the manual run is live must be skipped.
      job.anchorMs = Date.now() - 2_000
      await world.store.putJob(job)
      await world.scheduler.tick()
      await waitFor(() => world.store.listRuns(job.id).some(run => run.status === 'skipped'), 20_000)
      await waitFor(() => world.store.listRuns(job.id).some(run => run.status === 'ok'), 20_000)
    } finally {
      await world.cleanup()
    }
  })

  it('respects the global concurrency cap', { timeout: 30_000 }, async () => {
    const world = await makeWorld(1)
    try {
      const slow = quickJob({ name: 'slow', task: { kind: 'command', argv: [process.execPath, '-e', 'await new Promise(r => setTimeout(r, 800))'] } })
      const other = quickJob({ name: 'other', anchorMs: Date.now() + 3_600_000 })
      await world.store.putJob(slow)
      await world.store.putJob(other)
      const first = await world.scheduler.runNow(slow.id)
      expect(first.ok).toBe(true)
      const second = await world.scheduler.runNow(other.id)
      expect(second.ok).toBe(false)
      expect(second.error).toContain('并发')
    } finally {
      await world.cleanup()
    }
  })

  it('archives looping jobs whose window has expired', { timeout: 20_000 }, async () => {
    const world = await makeWorld()
    try {
      const job = quickJob({ window: { endAt: new Date(Date.now() - 1_000).toISOString() } })
      await world.store.putJob(job)
      await world.scheduler.tick()
      const stored = world.store.getJob(job.id)!
      expect(stored.archivedAt).toBeDefined()
      expect(stored.enabled).toBe(false)
    } finally {
      await world.cleanup()
    }
  })

  it('archives a one-shot job after it fires', { timeout: 20_000 }, async () => {
    const world = await makeWorld()
    try {
      const at = new Date(Date.now() + 60_000).toISOString()
      const job = quickJob({ trigger: { kind: 'oneshot', at } })
      await world.store.putJob(job)
      await world.scheduler.runNow(job.id)
      await waitFor(() => world.store.getJob(job.id)?.archivedAt !== undefined, 15_000)
    } finally {
      await world.cleanup()
    }
  })
})

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('waitFor timed out')
}
