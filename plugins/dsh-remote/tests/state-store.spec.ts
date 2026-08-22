import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_HOST_SESSIONS, RemoteStateStore } from '../src/state-store.ts'

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

  it('uses an environment-provided token only when creating the state file', async () => {
    const path = await statePath()
    const configured = Buffer.alloc(32, 7).toString('base64url')
    const store = await RemoteStateStore.open(path, { initialToken: configured })
    expect(store.accessToken()).toBe(configured)

    const replacement = Buffer.alloc(32, 9).toString('base64url')
    expect((await RemoteStateStore.open(path, { initialToken: replacement })).accessToken()).toBe(configured)
  })

  it('rejects an invalid initial token before creating state', async () => {
    const path = await statePath()
    await expect(RemoteStateStore.open(path, { initialToken: 'not-a-token' })).rejects.toThrow('256-bit base64url')
  })

  it('rejects a state file that could expose a persistent bearer credential', async () => {
    const path = await statePath()
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, JSON.stringify({ schema: 1, token: 'a'.repeat(43), sessionVersion: 1, createdAt: 'now', rotatedAt: 'now' }), { mode: 0o644 })
    await expect(RemoteStateStore.open(path)).rejects.toThrow('mode 0600')
  })

  it('rejects malformed bearers without throwing and remains usable', async () => {
    const path = await statePath()
    const store = await RemoteStateStore.open(path)
    expect(store.verifyBearer('界'.repeat(43))).toBe(false)
    expect(store.verifyBearer('!'.repeat(43))).toBe(false)
    expect(store.verifyBearer('a'.repeat(44))).toBe(false)
    expect(store.verifyBearer(store.accessToken())).toBe(true)
  })

  it('serializes rotations and keeps reopened disk state aligned', async () => {
    const path = await statePath()
    const store = await RemoteStateStore.open(path)
    const [first, second] = await Promise.all([store.rotate(), store.rotate()])
    expect(first.sessionVersion).toBe(2)
    expect(second.sessionVersion).toBe(3)
    expect((await RemoteStateStore.open(path)).current()).toEqual(store.current())
  })

  it('preserves the old state before rename and publishes post-rename failures', async () => {
    const path = await statePath()
    const initial = await RemoteStateStore.open(path)
    const before = initial.current()
    const failing = await RemoteStateStore.open(path, { beforeRename: async () => { throw new Error('before rename') } })
    await expect(failing.rotate()).rejects.toThrow('before rename')
    expect((await RemoteStateStore.open(path)).current()).toEqual(before)

    const committed = await RemoteStateStore.open(path, { afterRename: async () => { throw new Error('after rename') } })
    const next = await committed.rotate()
    expect(next.sessionVersion).toBe(before.sessionVersion + 1)
    expect((await RemoteStateStore.open(path)).current()).toEqual(next)
  })

  it('persists only bounded Host grant digests across restart and private-link rotation', async () => {
    const path = await statePath()
    const store = await RemoteStateStore.open(path)
    const grants = Array.from({ length: MAX_HOST_SESSIONS + 2 }, (_, index) => Buffer.alloc(32, index + 1).toString('base64url'))
    const now = Date.now()
    for (const [index, grant] of grants.entries()) {
      await store.addHostSession(grant, now + 20_000 + index, now)
    }
    await store.rotate()

    const disk = await readFile(path, 'utf8')
    for (const grant of grants) expect(disk).not.toContain(grant)
    expect(JSON.parse(disk).hostSessions).toHaveLength(MAX_HOST_SESSIONS)
    expect(store.verifyHostGrant(grants[0], now + 500)).toBeNull()
    expect(store.verifyHostGrant(grants[1], now + 500)).toBeNull()
    expect(store.verifyHostGrant(grants.at(-1), now + 500)).not.toBeNull()

    const restarted = await RemoteStateStore.open(path)
    expect(restarted.verifyHostGrant(grants.at(-1), now + 500)).not.toBeNull()
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('prunes expired Host grant digests from persistent state', async () => {
    const path = await statePath()
    const store = await RemoteStateStore.open(path)
    const grant = Buffer.alloc(32, 42).toString('base64url')
    await store.addHostSession(grant, 2_000, 1_000)
    expect(store.verifyHostGrant(grant, 1_999)).not.toBeNull()
    expect(store.verifyHostGrant(grant, 2_000)).toBeNull()
    await store.pruneExpiredHostSessions(2_000)
    expect(JSON.parse(await readFile(path, 'utf8')).hostSessions).toEqual([])
  })

  it('migrates schema 1 state without inventing plaintext Host sessions', async () => {
    const path = await statePath()
    await mkdir(join(path, '..'), { recursive: true })
    const token = Buffer.alloc(32, 7).toString('base64url')
    await writeFile(path, JSON.stringify({ schema: 1, token, sessionVersion: 3, createdAt: 'created', rotatedAt: 'rotated' }), { mode: 0o600 })
    const store = await RemoteStateStore.open(path)
    expect(store.current()).toMatchObject({ schema: 2, token, sessionVersion: 3, hostSessions: [] })
    expect(JSON.parse(await readFile(path, 'utf8')).schema).toBe(2)
  })

  it('rejects unknown state fields that could retain a plaintext Host grant', async () => {
    const path = await statePath()
    await mkdir(join(path, '..'), { recursive: true })
    const token = Buffer.alloc(32, 7).toString('base64url')
    await writeFile(path, JSON.stringify({
      schema: 2, token, sessionVersion: 1, createdAt: 'created', rotatedAt: 'rotated', hostSessions: [],
      sessionGrant: Buffer.alloc(32, 8).toString('base64url'),
    }), { mode: 0o600 })
    await expect(RemoteStateStore.open(path)).rejects.toThrow('unknown fields')
  })
})
