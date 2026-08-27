import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { TemporaryFileStore } from './file-store.ts'
import { registerAttachmentApi } from './http-api.ts'

export const name = 'dsh-file-attachment'
export const inject = ['webServer']

export interface Config {
  root?: string
  maxFileBytes?: number
  maxFilesPerMessage?: number
  maxMessageBytes?: number
  ttlMs?: number
  cleanupIntervalMs?: number
  allowedOrigins?: string[]
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const store = await TemporaryFileStore.create({
    root: config.root ?? dshHomePath('attachments', 'tmp'),
    maxFileBytes: config.maxFileBytes ?? 25 * 1024 * 1024,
    maxFilesPerMessage: config.maxFilesPerMessage ?? 10,
    maxMessageBytes: config.maxMessageBytes ?? 100 * 1024 * 1024,
    ttlMs: config.ttlMs ?? 24 * 60 * 60 * 1000,
  })
  const intervalMs = config.cleanupIntervalMs ?? 60 * 60 * 1000
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) throw new Error('dsh-file-attachment: cleanupIntervalMs must be a positive integer')
  const timer = setInterval(() => void store.cleanup(), intervalMs)
  timer.unref()
  const disposeApi = registerAttachmentApi(ctx.webServer, store, config.allowedOrigins ?? [])
  ctx.effect(() => () => {
    clearInterval(timer)
    disposeApi()
  }, 'dsh-file-attachment: temporary store and HTTP API')
}

export { AttachmentError, TemporaryFileStore, decodeCanonicalBase64, sanitizeDisplayName } from './file-store.ts'
export { appendAttachmentReferences, formatAttachmentReference } from './reference.ts'
export type { AttachmentLimits, UploadedFile, UploadInput } from './contracts.ts'
