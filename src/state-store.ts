import { chmod, lstat, mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { RemoteState } from './contracts.ts'

export const REMOTE_COOKIE = '__Host-dsh_remote'
const TOKEN_BYTES = 32
const FILE_MODE = 0o600

export class RemoteStateStore {
  private constructor(readonly filePath: string, private state: RemoteState) {}

  static async open(filePath: string): Promise<RemoteStateStore> {
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
    try {
      const details = await lstat(filePath)
      if (!details.isFile() || details.isSymbolicLink()) throw new Error('Remote state must be a regular file.')
      if ((details.mode & 0o077) !== 0) throw new Error('Remote state permissions must be mode 0600.')
      return new RemoteStateStore(filePath, parseState(await readFile(filePath, 'utf8')))
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
        const store = new RemoteStateStore(filePath, state)
        await store.write(state)
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
    if (typeof candidate !== 'string' || candidate.length !== this.state.token.length) return false
    return timingSafeEqual(Buffer.from(candidate), Buffer.from(this.state.token))
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
    const next: RemoteState = {
      ...this.state,
      token: token(),
      sessionVersion: this.state.sessionVersion + 1,
      rotatedAt: new Date().toISOString(),
    }
    await this.write(next)
    this.state = next
    return this.current()
  }

  private sessionMac(version: number): string {
    return createHmac('sha256', Buffer.from(this.state.token, 'base64url'))
      .update(`dsh-remote/session/${version}`, 'utf8')
      .digest('base64url')
  }

  private async write(state: RemoteState): Promise<void> {
    const temporary = `${this.filePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    const handle = await open(temporary, 'wx', FILE_MODE)
    try {
      await handle.chmod(FILE_MODE)
      await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, this.filePath)
    await chmod(this.filePath, FILE_MODE)
    const directory = await open(dirname(this.filePath), 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
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
    return value.length === 43 && Buffer.from(value, 'base64url').length === TOKEN_BYTES
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
