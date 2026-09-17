import { describe, expect, it, vi } from 'vitest'
import { CronStore } from '../src/store.ts'
import type { CronJob, CronRun } from '../src/types.ts'

function makeJob(id: string): CronJob {
  return {
    id,
    name: id,
    source: 'manual',
    trigger: { kind: 'interval', everySeconds: 60 },
    task: { kind: 'command', argv: ['/bin/true'] },
    overlap: 'skip',
    misfire: 'skip',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    seq: 0,
  }
}

function makeRun(jobId: string, seq: number): CronRun {
  return { jobId, seq, targetMs: seq, startedAt: seq, status: 'ok', summary: `run ${seq}` }
}

describe('CronStore (in-memory fallback mode)', () => {
  it('warns and stays functional when the domain facility is absent', async () => {
    const warn = vi.fn()
    const store = await CronStore.open(undefined, warn)
    expect(store.persistent).toBe(false)
    expect(warn).toHaveBeenCalled()
  })

  it('reports persistent=true with a facility and round-trips jobs', async () => {
    const tables = new Map<string, Map<string, unknown>>()
    const facility = {
      open: async (spec: { name: string; tables: Record<string, unknown> }) => {
        for (const name of Object.keys(spec.tables)) {
          if (!tables.has(name)) tables.set(name, new Map())
        }
        return {
          table: <V,>(name: string) => {
            const map = tables.get(name) as Map<string, V>
            return {
              get: (key: string) => map.get(key),
              entries: () => map.entries() as IterableIterator<[string, V]>,
              put: async (key: string, value: V) => {
                map.set(key, value)
              },
              delete: async (key: string) => map.delete(key),
            }
          },
          close: async () => undefined,
        }
      },
    }
    const store = await CronStore.open({ domain: facility }, () => undefined)
    expect(store.persistent).toBe(true)
    expect(tables.get('jobs')).toBeDefined()
    expect(tables.get('runs')).toBeDefined()

    const job = makeJob('cron-a')
    await store.putJob(job)
    expect(store.getJob('cron-a')?.name).toBe('cron-a')
    expect(store.findByName('cron-a')?.id).toBe('cron-a')
  })

  it('trims run history to the limit, newest first', async () => {
    const store = await CronStore.open(undefined, () => undefined)
    await store.putJob(makeJob('cron-b'))
    for (let seq = 1; seq <= 7; seq++) {
      await store.putRun(makeRun('cron-b', seq), 5)
    }
    const runs = store.listRuns('cron-b')
    expect(runs).toHaveLength(5)
    expect(runs[0]!.seq).toBe(7)
    expect(runs[4]!.seq).toBe(3)
  })

  it('updates runs in place and cascades delete to history', async () => {
    const store = await CronStore.open(undefined, () => undefined)
    await store.putJob(makeJob('cron-c'))
    await store.putRun(makeRun('cron-c', 1), 10)
    const updated = await store.updateRun('cron-c', 1, { status: 'failed', summary: 'boom' })
    expect(updated?.status).toBe('failed')
    expect(await store.deleteJob('cron-c')).toBe(true)
    expect(store.listRuns('cron-c')).toHaveLength(0)
    expect(store.getJob('cron-c')).toBeUndefined()
  })

  it('repairs interrupted running records as aborted on boot', async () => {
    const store = await CronStore.open(undefined, () => undefined)
    await store.putJob(makeJob('cron-d'))
    await store.putRun({ ...makeRun('cron-d', 1), status: 'running' }, 10)
    await store.putRun(makeRun('cron-d', 2), 10)
    const repaired = await store.repairInterrupted()
    expect(repaired).toBe(1)
    expect(store.listRuns('cron-d').find(run => run.seq === 1)?.status).toBe('aborted')
    expect(store.listRuns('cron-d').find(run => run.seq === 2)?.status).toBe('ok')
  })
})
