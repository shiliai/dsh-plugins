import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import FileIcon from 'lucide-react/dist/esm/icons/file'
import LoaderCircle from 'lucide-react/dist/esm/icons/loader-circle'
import Paperclip from 'lucide-react/dist/esm/icons/paperclip'
import X from 'lucide-react/dist/esm/icons/x'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { AttachmentLimits, UploadedFile } from '../contracts.ts'
import { attachmentApi } from './api.ts'
import { clipboardFiles } from './clipboard.ts'
import { DraftAttachmentStore } from './draft-store.ts'
import { appendClientReferences, formatClientReference, removeClientReference } from './reference.ts'
import { css } from './styles.ts'

interface InjectedProps {
  store: DraftAttachmentStore
}

type InputProps = PropsRuntime<'conversation.input.left'> & InjectedProps
type DockProps = PropsRuntime<'conversation.input.dock'> & InjectedProps

export function AttachmentButton(props: InputProps) {
  const { inputActions, sessionId, store, useInput } = props
  const sessionKey = String(sessionId)
  const draft = useInput(state => state.draft)
  const phase = useInput(state => state.phase)
  const state = useDraftAttachments(store, sessionKey)
  const [limits, setLimits] = useState<AttachmentLimits>()
  const inputRef = useRef<HTMLInputElement>(null)
  const draftRef = useRef(draft)
  const phaseRef = useRef(phase)
  const stateRef = useRef(state)
  const uploadingRef = useRef(false)
  draftRef.current = draft
  phaseRef.current = phase
  stateRef.current = state

  useEffect(() => {
    void attachmentApi.limits().then(setLimits).catch(error => store.setError(sessionKey, messageOf(error)))
  }, [sessionKey, store])

  const addFiles = useCallback(async (files: readonly File[]) => {
    if (files.length === 0 || phaseRef.current !== 'plain' || uploadingRef.current) return
    const error = validateClientBatch(files, stateRef.current.files, limits)
    if (error !== undefined) return store.setError(sessionKey, error)
    uploadingRef.current = true
    store.setUploading(sessionKey, true)
    try {
      const uploaded = await attachmentApi.uploadFiles(files, stateRef.current.files.map(file => file.fileId))
      store.add(sessionKey, uploaded)
      const nextDraft = appendClientReferences(draftRef.current, uploaded)
      draftRef.current = nextDraft
      inputActions.setDraft(nextDraft)
    } catch (error) {
      store.setError(sessionKey, messageOf(error))
    } finally {
      uploadingRef.current = false
      store.setUploading(sessionKey, false)
    }
  }, [inputActions, limits, sessionKey, store])

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (!isComposerTextTarget(event.target)) return
      const files = clipboardFiles(event.clipboardData)
      if (files.length === 0) return
      event.preventDefault()
      void addFiles(files)
    }
    const onDragOver = (event: DragEvent) => {
      if (phaseRef.current !== 'plain' || !hasFiles(event.dataTransfer)) return
      event.preventDefault()
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy'
    }
    const onDrop = (event: DragEvent) => {
      if (phaseRef.current !== 'plain' || !hasFiles(event.dataTransfer)) return
      const files = event.dataTransfer === null ? [] : fileList(event.dataTransfer.files)
      if (files.length === 0) return
      event.preventDefault()
      void addFiles(files)
    }
    document.addEventListener('paste', onPaste, true)
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('drop', onDrop)
    return () => {
      document.removeEventListener('paste', onPaste, true)
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('drop', onDrop)
    }
  }, [addFiles])

  const disabled = phase !== 'plain' || state.uploading
  return (
    <>
      <input
        ref={inputRef}
        className={css.hiddenInput}
        type="file"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        onChange={event => {
          void addFiles(fileList(event.currentTarget.files))
          event.currentTarget.value = ''
        }}
      />
      <button
        className={css.attachButton}
        type="button"
        title="Attach local file"
        aria-label="Attach local file"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        {state.uploading ? <LoaderCircle className={css.spinner} size={17} /> : <Paperclip size={17} />}
      </button>
    </>
  )
}

export function AttachmentDock(props: DockProps) {
  const { inputActions, sessionId, store, useInput } = props
  const sessionKey = String(sessionId)
  const draft = useInput(state => state.draft)
  const state = useDraftAttachments(store, sessionKey)

  useEffect(() => {
    store.retain(sessionKey, file => draft.includes(formatClientReference(file)))
  }, [draft, sessionKey, store])

  const remove = async (file: UploadedFile) => {
    try {
      await attachmentApi.remove(file.fileId)
      store.remove(sessionKey, file.fileId)
      inputActions.setDraft(removeClientReference(draft, file))
    } catch (error) {
      store.setError(sessionKey, messageOf(error))
    }
  }

  if (state.files.length === 0 && state.error === undefined) return null
  return (
    <div className={css.files}>
      {state.files.map(file => (
        <div className={css.fileRow} key={file.fileId} title={file.uri}>
          <span className={css.fileIcon} aria-hidden="true"><FileIcon size={16} /></span>
          <span className={css.fileMeta}>
            <span className={css.fileName}>{file.name}</span>
            <small>{file.mediaType} · {formatBytes(file.bytes)}</small>
          </span>
          <button className={css.removeButton} type="button" title="Remove attachment" aria-label={`Remove ${file.name}`} onClick={() => void remove(file)}>
            <X size={15} />
          </button>
        </div>
      ))}
      {state.error !== undefined && <div className={css.error} role="alert">{state.error}</div>}
    </div>
  )
}

function useDraftAttachments(store: DraftAttachmentStore, sessionId: string) {
  return useSyncExternalStore(store.subscribe, () => store.get(sessionId), () => store.get(sessionId))
}

export function isComposerTextTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLTextAreaElement || target instanceof HTMLElement && target.isContentEditable
}

function hasFiles(data: DataTransfer | null): boolean {
  if (data === null) return false
  for (let index = 0; index < data.types.length; index += 1) {
    if (data.types[index] === 'Files') return true
  }
  return data.files.length > 0
}

function fileList(files: FileList | null): File[] {
  if (files === null) return []
  const result: File[] = []
  for (let index = 0; index < files.length; index += 1) {
    const file = files.item(index)
    if (file !== null) result.push(file)
  }
  return result
}

function validateClientBatch(files: readonly File[], existing: readonly UploadedFile[], limits?: AttachmentLimits): string | undefined {
  if (limits === undefined) return undefined
  if (existing.length + files.length > limits.maxFilesPerMessage) return `A message may contain at most ${limits.maxFilesPerMessage} files.`
  if (files.some(file => file.size > limits.maxFileBytes)) return `One file exceeds the ${formatBytes(limits.maxFileBytes)} limit.`
  const total = existing.reduce((sum, file) => sum + file.bytes, 0) + files.reduce((sum, file) => sum + file.size, 0)
  return total > limits.maxMessageBytes ? `Attachments exceed the ${formatBytes(limits.maxMessageBytes)} message limit.` : undefined
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to attach file.'
}
