import type { ApiErrorPayload, AttachmentLimits, UploadedFile } from '../contracts.ts'

const API = '/dsh-file-attachment/api'

export class AttachmentApiError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, init)
  if (!response.ok) {
    let payload: ApiErrorPayload = { error: `Attachment request failed (${response.status}).`, code: 'REQUEST_FAILED' }
    try { payload = await response.json() as ApiErrorPayload } catch { /* no JSON error body */ }
    throw new AttachmentApiError(payload.error, payload.code, response.status)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export async function uploadFiles(files: readonly File[], existingFileIds: readonly string[] = [], signal?: AbortSignal): Promise<readonly UploadedFile[]> {
  const encoded = await Promise.all(files.map(async file => ({
    name: file.name,
    mediaType: file.type || 'application/octet-stream',
    data: await fileBase64(file),
  })))
  const result = await request<{ files: UploadedFile[] }>('/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: encoded, existingFileIds }),
    ...(signal === undefined ? {} : { signal }),
  })
  return result.files
}

export const attachmentApi = {
  limits: () => request<AttachmentLimits>('/limits'),
  uploadFiles,
  remove: (fileId: string) => request<void>('/file', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId }),
  }),
}

function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read file.'))
    reader.onload = () => {
      if (typeof reader.result !== 'string') return reject(new Error('Unable to encode file.'))
      const comma = reader.result.indexOf(',')
      if (comma < 0) return reject(new Error('Unable to encode file.'))
      resolve(reader.result.slice(comma + 1))
    }
    reader.readAsDataURL(file)
  })
}
