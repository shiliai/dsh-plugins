import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendStats } from '../src/stats.ts'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('stats appendStats', () => {
  it('appends one JSON line per record and creates the directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-team-stats-'))
    dirs.push(dir)
    const file = join(dir, 'nested', 'routing-stats.jsonl')
    await appendStats(file, { ts: '2026-09-22T00:00:00Z', task: 't'.repeat(250), decision: 'worker', worker: 'w1', durationMs: 12, jevDurationMs: 3 })
    await appendStats(file, { ts: '2026-09-22T00:00:01Z', task: 'x', decision: 'leader', durationMs: 5 })
    const lines = (await readFile(file, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    const first = JSON.parse(lines[0] as string)
    expect(first.decision).toBe('worker')
    expect(first.worker).toBe('w1')
    expect(first.task).toHaveLength(250)
    const second = JSON.parse(lines[1] as string)
    expect(second.decision).toBe('leader')
    expect(second.worker).toBeUndefined()
  })

  it('is a no-op when file is null', async () => {
    await expect(appendStats(null, { ts: 't', task: 'x', decision: 'leader', durationMs: 1 })).resolves.toBeUndefined()
  })

  it('warns instead of throwing when the write fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-team-stats-'))
    dirs.push(dir)
    const blocker = join(dir, 'blocker')
    await writeFile(blocker, 'not a directory')
    const warnings: string[] = []
    await appendStats(join(blocker, 'child', 'x.jsonl'), {
      ts: 't', task: 'x', decision: 'leader', durationMs: 1,
    }, message => warnings.push(message))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('routing stats')
  })
})
