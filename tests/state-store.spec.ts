import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RemoteStateStore } from '../src/state-store.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function statePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-remote-state-'))
  roots.push(root)
  return join(root, 'private', 'state.json')
}

describe('RemoteStateStore', () => {
  it('creates a mode-0600 state file and atomically rotates its token and session verifier', async () => {
    const path = await statePath()
    const store = await RemoteStateStore.open(path)
    const initial = store.current()
    const initialCookie = store.sessionCookie()

    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(store.verifyBearer(initial.token)).toBe(true)
    expect(store.verifyBearer(`${initial.token}x`)).toBe(false)
    expect(store.authenticateCookie(`other=value; __Host-dsh_remote=${initialCookie}`)).toBe(initial.sessionVersion)

    const rotated = await store.rotate()
    expect(rotated.sessionVersion).toBe(initial.sessionVersion + 1)
    expect(rotated.token).not.toBe(initial.token)
    expect(store.authenticateCookie(`__Host-dsh_remote=${initialCookie}`)).toBeNull()
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readdir(join(path, '..'))).toEqual(['state.json'])

    const reloaded = await RemoteStateStore.open(path)
    expect(reloaded.current()).toEqual(rotated)
  })

  it('rejects a state file that could expose a persistent bearer credential', async () => {
    const path = await statePath()
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, JSON.stringify({ schema: 1, token: 'a'.repeat(43), sessionVersion: 1, createdAt: 'now', rotatedAt: 'now' }), { mode: 0o644 })
    await expect(RemoteStateStore.open(path)).rejects.toThrow('mode 0600')
  })
})
