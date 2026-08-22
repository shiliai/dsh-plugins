import type { UploadedFile } from '../contracts.ts'

export interface DraftAttachmentState {
  files: readonly UploadedFile[]
  uploading: boolean
  error?: string
}

const EMPTY_STATE: DraftAttachmentState = { files: [], uploading: false }

export class DraftAttachmentStore {
  private readonly bySession = new Map<string, DraftAttachmentState>()
  private readonly listeners = new Set<() => void>()

  get(sessionId: string): DraftAttachmentState {
    return this.bySession.get(sessionId) ?? EMPTY_STATE
  }

  add(sessionId: string, files: readonly UploadedFile[]): void {
    this.update(sessionId, state => ({ ...withoutError(state), files: [...state.files, ...files] }))
  }

  remove(sessionId: string, fileId: string): void {
    this.update(sessionId, state => ({ ...withoutError(state), files: state.files.filter(file => file.fileId !== fileId) }))
  }

  retain(sessionId: string, predicate: (file: UploadedFile) => boolean): void {
    const previous = this.get(sessionId)
    const next = previous.files.filter(predicate)
    if (next.length === previous.files.length) return
    this.update(sessionId, state => ({ ...state, files: next }))
  }

  setUploading(sessionId: string, uploading: boolean): void {
    this.update(sessionId, state => uploading ? { ...withoutError(state), uploading } : { ...state, uploading })
  }

  setError(sessionId: string, error: string): void {
    this.update(sessionId, state => ({ ...state, uploading: false, error }))
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  private update(sessionId: string, update: (state: DraftAttachmentState) => DraftAttachmentState): void {
    const next = update(this.get(sessionId))
    if (next.files.length === 0 && !next.uploading && next.error === undefined) this.bySession.delete(sessionId)
    else this.bySession.set(sessionId, next)
    this.emit()
  }
}

function withoutError(state: DraftAttachmentState): Omit<DraftAttachmentState, 'error'> {
  const { error: _error, ...rest } = state
  return rest
}
