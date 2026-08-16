import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { RemoteState } from './contracts.ts'

export const REMOTE_COOKIE = '__Host-dsh_remote'
const TOKEN_BYTES = 32
const FILE_MODE = 0o600
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u

export interface RemoteStateStoreHooks {
  beforeRename?(): Promise<void>
  afterRename?(): Promise<void>
}

export class RemoteStateStore {
  private rotationQueue: Promise<void> = Promise.resolve()

  private constructor(readonly filePath: string, private state: RemoteState, private readonly hooks: RemoteStateStoreHooks) {}

  static async open(filePath: string, hooks: RemoteStateStoreHooks = {}): Promise<RemoteStateStore> {
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
    try {
      const details = await lstat(filePath)
      if (!details.isFile() || details.isSymbolicLink()) throw new Error('Remote state must be a regular file.')
      if ((details.mode & 0o077) !== 0) throw new Error('Remote state permissions must be mode 0600.')
      return new RemoteStateStore(filePath, parseState(await readFile(filePath, 'utf8')), hooks)
    } catch (error) {
      if (isNotFound(error)) {
        const now = new Date().toISOString()
        const state: RemoteState = {
          schema: 1,
          token: token(),
          sessionVersion: 1,
          createdAt: now,
          rotatedAt: now,
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
    const operation = this.rotationQueue.then(async () => this.rotateOnce())
    this.rotationQueue = operation.then(() => undefined, () => undefined)
    return operation
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

function parseState(source: string): RemoteState {
  let value: unknown
  try {
    value = JSON.parse(source) as unknown
  } catch {
    throw new Error('Remote state is not valid JSON.')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Remote state has an invalid shape.')
  const state = value as Partial<RemoteState>
  if (state.schema !== 1 || typeof state.token !== 'string' || !isToken(state.token)
    || !Number.isSafeInteger(state.sessionVersion) || (state.sessionVersion ?? 0) < 1
    || typeof state.createdAt !== 'string' || typeof state.rotatedAt !== 'string') {
    throw new Error('Remote state has an invalid value.')
  }
  return state as RemoteState
}

function token(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
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
