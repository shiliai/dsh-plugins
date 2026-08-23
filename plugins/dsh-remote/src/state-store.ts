import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { HostSessionDigest, RemoteState } from './contracts.ts'

export const REMOTE_COOKIE = '__Host-dsh_remote'
const TOKEN_BYTES = 32
const FILE_MODE = 0o600
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u
export const MAX_HOST_SESSIONS = 16

export interface RemoteStateStoreHooks {
  beforeRename?(): Promise<void>
  afterRename?(): Promise<void>
  initialToken?: string | undefined
}

export class RemoteStateStore {
  private writeQueue: Promise<void> = Promise.resolve()

  private constructor(readonly filePath: string, private state: RemoteState, private readonly hooks: RemoteStateStoreHooks) {}

  static async open(filePath: string, hooks: RemoteStateStoreHooks = {}): Promise<RemoteStateStore> {
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
    try {
      const details = await lstat(filePath)
      if (!details.isFile() || details.isSymbolicLink()) throw new Error('Remote state must be a regular file.')
      if ((details.mode & 0o077) !== 0) throw new Error('Remote state permissions must be mode 0600.')
      const parsed = parseState(await readFile(filePath, 'utf8'))
      const active = parsed.state.hostSessions.filter(session => session.expiresAt > Date.now())
      const state = { ...parsed.state, hostSessions: active }
      const store = new RemoteStateStore(filePath, state, hooks)
      if (parsed.migrated || active.length !== parsed.state.hostSessions.length) await store.commit(state)
      return store
    } catch (error) {
      if (isNotFound(error)) {
        const now = new Date().toISOString()
        const state: RemoteState = {
          schema: 2,
          token: initialToken(hooks.initialToken),
          sessionVersion: 1,
          createdAt: now,
          rotatedAt: now,
          hostSessions: [],
        }
        const store = new RemoteStateStore(filePath, state, hooks)
        await store.commit(state)
        return store
      }
      throw error
    }
  }

  current(): Readonly<RemoteState> {
    return { ...this.state }
  }

  accessToken(): string {
    return this.state.token
  }

  verifyBearer(candidate: unknown): boolean {
    if (typeof candidate !== 'string' || !isToken(candidate)) return false
    const supplied = Buffer.from(candidate, 'base64url')
    const expected = Buffer.from(this.state.token, 'base64url')
    return supplied.length === expected.length && timingSafeEqual(supplied, expected)
  }

  sessionCookie(): string {
    return `${this.state.sessionVersion}.${this.sessionMac(this.state.sessionVersion)}`
  }

  authenticateCookie(header: string | undefined): number | null {
    const cookie = cookieValue(header, REMOTE_COOKIE)
    if (cookie === undefined) return null
    const match = /^(\d+)\.([A-Za-z0-9_-]{43})$/u.exec(cookie)
    if (match === null) return null
    const version = Number(match[1])
    const signature = match[2]
    if (!Number.isSafeInteger(version) || version !== this.state.sessionVersion || signature === undefined) return null
    const expected = this.sessionMac(version)
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected)) ? version : null
  }

  async rotate(): Promise<Readonly<RemoteState>> {
    const operation = this.writeQueue.then(async () => this.rotateOnce())
    this.writeQueue = operation.then(() => undefined, () => undefined)
    return operation
  }

  hostSessions(): HostSessionDigest[] {
    return this.state.hostSessions.map(session => ({ ...session }))
  }

  verifyHostGrant(candidate: unknown, now = Date.now()): HostSessionDigest | null {
    if (typeof candidate !== 'string' || !isToken(candidate)) return null
    const supplied = Buffer.from(hostGrantDigest(candidate))
    for (const session of this.state.hostSessions) {
      if (session.expiresAt <= now) continue
      const expected = Buffer.from(session.digest)
      if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) return { ...session }
    }
    return null
  }

  async addHostSession(grant: string, expiresAt: number, now = Date.now()): Promise<{ session: HostSessionDigest; removed: string[] }> {
    if (!isToken(grant) || !Number.isSafeInteger(expiresAt) || expiresAt <= now) throw new Error('Invalid Host session grant.')
    return this.enqueue(async () => {
      const session = { digest: hostGrantDigest(grant), expiresAt }
      const retained = this.state.hostSessions
        .filter(candidate => candidate.expiresAt > now && candidate.digest !== session.digest)
      retained.push(session)
      retained.sort((left, right) => left.expiresAt - right.expiresAt)
      const removed = retained.length > MAX_HOST_SESSIONS
        ? retained.splice(0, retained.length - MAX_HOST_SESSIONS).map(candidate => candidate.digest)
        : []
      await this.commit({ ...this.state, hostSessions: retained })
      return { session: { ...session }, removed }
    })
  }

  async removeHostSession(digest: string): Promise<void> {
    await this.enqueue(async () => {
      const retained = this.state.hostSessions.filter(session => session.digest !== digest)
      if (retained.length !== this.state.hostSessions.length) await this.commit({ ...this.state, hostSessions: retained })
    })
  }

  async pruneExpiredHostSessions(now = Date.now()): Promise<void> {
    await this.enqueue(async () => {
      const retained = this.state.hostSessions.filter(session => session.expiresAt > now)
      if (retained.length !== this.state.hostSessions.length) await this.commit({ ...this.state, hostSessions: retained })
    })
  }

  async flush(): Promise<void> {
    await this.writeQueue
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.writeQueue.then(operation)
    this.writeQueue = queued.then(() => undefined, () => undefined)
    return queued
  }

  private async rotateOnce(): Promise<Readonly<RemoteState>> {
    const next: RemoteState = {
      ...this.state,
      token: token(),
      sessionVersion: this.state.sessionVersion + 1,
      rotatedAt: new Date().toISOString(),
    }
    await this.commit(next)
    return this.current()
  }

  private sessionMac(version: number): string {
    return createHmac('sha256', Buffer.from(this.state.token, 'base64url'))
      .update(`dsh-remote/session/${version}`, 'utf8')
      .digest('base64url')
  }

  private async commit(state: RemoteState): Promise<void> {
    const temporary = `${this.filePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    let renamed = false
    const handle = await open(temporary, 'wx', FILE_MODE)
    try {
      try {
        await handle.chmod(FILE_MODE)
        await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await this.hooks.beforeRename?.()
      await rename(temporary, this.filePath)
      renamed = true
      this.state = state
      try {
        await this.hooks.afterRename?.()
        const directory = await open(dirname(this.filePath), 'r')
        try {
          await directory.sync()
        } finally {
          await directory.close()
        }
      } catch {
        // Rename is the commit point; callers must receive the committed link.
      }
    } finally {
      if (!renamed) await rm(temporary, { force: true })
    }
  }
}

function parseState(source: string): { state: RemoteState; migrated: boolean } {
  let value: unknown
  try {
    value = JSON.parse(source) as unknown
  } catch {
    throw new Error('Remote state is not valid JSON.')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Remote state has an invalid shape.')
  const raw = value as Record<string, unknown>
  const schema = raw.schema
  if ((schema !== 1 && schema !== 2) || typeof raw.token !== 'string' || !isToken(raw.token)
    || !Number.isSafeInteger(raw.sessionVersion) || (Number(raw.sessionVersion) || 0) < 1
    || typeof raw.createdAt !== 'string' || typeof raw.rotatedAt !== 'string') {
    throw new Error('Remote state has an invalid value.')
  }
  const expectedKeys = schema === 1
    ? ['schema', 'token', 'sessionVersion', 'createdAt', 'rotatedAt']
    : ['schema', 'token', 'sessionVersion', 'createdAt', 'rotatedAt', 'hostSessions']
  if (Object.keys(raw).length !== expectedKeys.length || !expectedKeys.every(key => Object.hasOwn(raw, key))) {
    throw new Error('Remote state has unknown fields.')
  }
  const hostSessions = schema === 1 ? [] : raw.hostSessions
  if (!Array.isArray(hostSessions) || hostSessions.length > MAX_HOST_SESSIONS || !hostSessions.every(isHostSessionDigest)) {
    throw new Error('Remote state has invalid Host sessions.')
  }
  return {
    state: {
      schema: 2,
      token: raw.token,
      sessionVersion: Number(raw.sessionVersion),
      createdAt: raw.createdAt,
      rotatedAt: raw.rotatedAt,
      hostSessions,
    },
    migrated: schema === 1,
  }
}

function isHostSessionDigest(value: unknown): value is HostSessionDigest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const session = value as Partial<HostSessionDigest>
  return Object.keys(value).length === 2 && typeof session.digest === 'string' && isToken(session.digest)
    && Number.isSafeInteger(session.expiresAt) && (session.expiresAt ?? 0) > 0
}

function hostGrantDigest(grant: string): string {
  return createHash('sha256').update(grant, 'utf8').digest('base64url')
}

function token(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

function initialToken(value: string | undefined): string {
  if (value === undefined) return token()
  if (!isToken(value)) throw new Error('Remote initial token must be a 256-bit base64url value.')
  return value
}

function isToken(value: string): boolean {
  try {
    return TOKEN_PATTERN.test(value) && Buffer.from(value, 'base64url').length === TOKEN_BYTES
  } catch {
    return false
  }
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return undefined
}
