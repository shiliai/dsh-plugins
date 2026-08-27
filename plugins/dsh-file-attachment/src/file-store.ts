import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readdir, stat, unlink } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AttachmentLimits, UploadInput, UploadedFile } from './contracts.ts'

export class AttachmentError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message)
  }
}

export interface FileStoreOptions extends AttachmentLimits {
  root: string
  ttlMs: number
  now?: () => number
}

export class TemporaryFileStore {
  readonly root: string
  readonly limits: AttachmentLimits
  readonly ttlMs: number
  private readonly now: () => number

  private constructor(options: FileStoreOptions) {
    this.root = resolve(options.root)
    this.limits = {
      maxFileBytes: positiveInteger(options.maxFileBytes, 'maxFileBytes'),
      maxFilesPerMessage: positiveInteger(options.maxFilesPerMessage, 'maxFilesPerMessage'),
      maxMessageBytes: positiveInteger(options.maxMessageBytes, 'maxMessageBytes'),
    }
    this.ttlMs = positiveInteger(options.ttlMs, 'ttlMs')
    this.now = options.now ?? Date.now
  }

  static async create(options: FileStoreOptions): Promise<TemporaryFileStore> {
    const store = new TemporaryFileStore(options)
    await mkdir(store.root, { recursive: true, mode: 0o700 })
    await chmod(store.root, 0o700)
    await store.cleanup()
    return store
  }

  async saveBatch(inputs: readonly UploadInput[], existingFileIds: readonly string[] = []): Promise<readonly UploadedFile[]> {
    if (inputs.length === 0 || inputs.length + existingFileIds.length > this.limits.maxFilesPerMessage) {
      throw new AttachmentError(`A message may contain 1-${this.limits.maxFilesPerMessage} files.`, 'FILE_COUNT_LIMIT', 400)
    }
    let total = 0
    for (const fileId of new Set(existingFileIds)) {
      try {
        total += (await stat(this.pathFor(fileId))).size
      } catch (error) {
        if (error instanceof AttachmentError) throw error
        throw new AttachmentError('An existing draft attachment is no longer available.', 'ATTACHMENT_MISSING', 409)
      }
    }
    const decoded = inputs.map(input => ({ input, data: decodeCanonicalBase64(input.data) }))
    for (const item of decoded) {
      if (item.data.byteLength > this.limits.maxFileBytes) {
        throw new AttachmentError(`File exceeds the ${this.limits.maxFileBytes} byte limit.`, 'FILE_TOO_LARGE', 413)
      }
      total += item.data.byteLength
    }
    if (total > this.limits.maxMessageBytes) {
      throw new AttachmentError(`Files exceed the ${this.limits.maxMessageBytes} byte message limit.`, 'MESSAGE_TOO_LARGE', 413)
    }

    const written: string[] = []
    try {
      const results: UploadedFile[] = []
      for (const { input, data } of decoded) {
        const name = sanitizeDisplayName(input.name)
        const fileId = `${randomUUID()}-${name}`
        const path = this.pathFor(fileId)
        const handle = await open(path, 'wx', 0o600)
        try {
          await handle.writeFile(data)
        } finally {
          await handle.close()
        }
        written.push(path)
        results.push({
          fileId,
          name,
          mediaType: normalizeMediaType(input.mediaType),
          bytes: data.byteLength,
          uri: pathToFileURL(path).href,
          expiresAt: this.now() + this.ttlMs,
        })
      }
      return results
    } catch (error) {
      await Promise.all(written.map(path => unlink(path).catch(() => undefined)))
      throw error
    }
  }

  async remove(fileId: string): Promise<void> {
    try {
      await unlink(this.pathFor(fileId))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  async cleanup(): Promise<number> {
    let removed = 0
    const entries = await readdir(this.root, { withFileTypes: true })
    await Promise.all(entries.map(async entry => {
      if (!entry.isFile()) return
      const path = this.pathFor(entry.name)
      try {
        const info = await stat(path)
        if (this.now() - info.mtimeMs <= this.ttlMs) return
        await unlink(path)
        removed += 1
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }))
    return removed
  }

  private pathFor(fileId: string): string {
    if (fileId !== basename(fileId) || !/^[0-9a-f-]{36}-.{1,120}$/u.test(fileId)) {
      throw new AttachmentError('Invalid attachment id.', 'INVALID_FILE_ID', 400)
    }
    const path = resolve(join(this.root, fileId))
    const fromRoot = relative(this.root, path)
    if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
      throw new AttachmentError('Invalid attachment path.', 'INVALID_FILE_ID', 400)
    }
    return path
  }
}

export function sanitizeDisplayName(value: string): string {
  const normalized = value.normalize('NFKC').replace(/[\u0000-\u001f\u007f/\\:]/gu, '_').trim()
  const compact = normalized.replace(/\s+/gu, ' ').replace(/^\.+/u, '')
  return (compact || 'attachment').slice(0, 100)
}

export function decodeCanonicalBase64(value: string): Buffer {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new AttachmentError('File data must be canonical base64.', 'INVALID_BASE64', 400)
  }
  const data = Buffer.from(value, 'base64')
  if (data.toString('base64') !== value) throw new AttachmentError('File data must be canonical base64.', 'INVALID_BASE64', 400)
  return data
}

function normalizeMediaType(value: string): string {
  const type = value.trim().toLowerCase()
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(type) ? type : 'application/octet-stream'
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`dsh-file-attachment: ${name} must be a positive integer`)
  return value
}
