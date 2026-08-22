import { chmod, mkdtemp, readFile, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AttachmentError, TemporaryFileStore, decodeCanonicalBase64, sanitizeDisplayName } from '../src/file-store.ts'

const roots: string[] = []

async function store(options: Partial<Parameters<typeof TemporaryFileStore.create>[0]> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-attachment-'))
  roots.push(root)
  return TemporaryFileStore.create({
    root,
    maxFileBytes: 16,
    maxFilesPerMessage: 3,
    maxMessageBytes: 20,
    ttlMs: 1_000,
    ...options,
  })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('TemporaryFileStore', () => {
  it('tightens an existing storage root to mode 0700', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-file-attachment-mode-'))
    roots.push(root)
    await chmod(root, 0o777)
    await TemporaryFileStore.create({ root, maxFileBytes: 16, maxFilesPerMessage: 3, maxMessageBytes: 20, ttlMs: 1_000 })
    expect((await stat(root)).mode & 0o777).toBe(0o700)
  })

  it('writes sanitized immutable files with local file URIs and mode 0600', async () => {
    const files = await (await store()).saveBatch([{ name: '../screen: shot.png', mediaType: 'IMAGE/PNG', data: Buffer.from('pixels').toString('base64') }])
    expect(files).toHaveLength(1)
    const file = files[0]!
    expect(file.name).toBe('_screen_ shot.png')
    expect(file.mediaType).toBe('image/png')
    expect(file.uri).toMatch(/^file:\/\//u)
    const path = fileURLToPath(file.uri)
    expect(await readFile(path, 'utf8')).toBe('pixels')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('accepts empty files and rejects malformed base64', async () => {
    expect(decodeCanonicalBase64('')).toEqual(Buffer.alloc(0))
    expect(() => decodeCanonicalBase64('not base64')).toThrowError(AttachmentError)
    const files = await (await store()).saveBatch([{ name: '', mediaType: '', data: '' }])
    expect(files[0]).toMatchObject({ name: 'attachment', bytes: 0, mediaType: 'application/octet-stream' })
  })

  it('enforces file, count, and aggregate limits across sequential draft uploads', async () => {
    const target = await store()
    await expect(target.saveBatch([{ name: 'large', mediaType: '', data: Buffer.alloc(17).toString('base64') }])).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
    await expect(target.saveBatch(new Array(4).fill({ name: 'x', mediaType: '', data: 'eA==' }))).rejects.toMatchObject({ code: 'FILE_COUNT_LIMIT' })
    const first = await target.saveBatch([{ name: 'first', mediaType: '', data: Buffer.alloc(12).toString('base64') }])
    await expect(target.saveBatch([{ name: 'second', mediaType: '', data: Buffer.alloc(9).toString('base64') }], [first[0]!.fileId])).rejects.toMatchObject({ code: 'MESSAGE_TOO_LARGE' })
    await expect(target.saveBatch([{ name: 'missing', mediaType: '', data: 'eA==' }], ['00000000-0000-0000-0000-000000000000-missing'])).rejects.toMatchObject({ code: 'ATTACHMENT_MISSING' })
  })

  it('removes explicit files and cleans expired files', async () => {
    let now = 2_000
    const target = await store({ now: () => now })
    const [removed] = await target.saveBatch([{ name: 'remove.txt', mediaType: 'text/plain', data: 'eA==' }])
    await target.remove(removed!.fileId)
    await expect(stat(fileURLToPath(removed!.uri))).rejects.toMatchObject({ code: 'ENOENT' })

    const [expired] = await target.saveBatch([{ name: 'expired.txt', mediaType: 'text/plain', data: 'eA==' }])
    await chmod(fileURLToPath(expired!.uri), 0o600)
    await utimes(fileURLToPath(expired!.uri), new Date(0), new Date(0))
    now = 10_000
    expect(await target.cleanup()).toBe(1)
  })
})

describe('sanitizeDisplayName', () => {
  it('removes path syntax, controls, leading dots, and bounds length', () => {
    expect(sanitizeDisplayName(' ../../a\\b\u0000.txt ')).toBe('_.._a_b_.txt')
    expect(sanitizeDisplayName('x'.repeat(200))).toHaveLength(100)
  })
})
