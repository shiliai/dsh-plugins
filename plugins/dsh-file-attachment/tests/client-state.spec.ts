import { describe, expect, it, vi } from 'vitest'
import type { UploadedFile } from '../src/contracts.ts'
import { clipboardFiles } from '../src/client/clipboard.ts'
import { DraftAttachmentStore } from '../src/client/draft-store.ts'

function fakeFile(name: string, size = 10): File {
  return { name, size, type: 'image/png', lastModified: 1 } as File
}

function transfer(files: File[], items: Array<{ kind: string; getAsFile(): File | null }>): DataTransfer {
  return {
    files: { length: files.length, item: index => files[index] ?? null } as FileList,
    items: Object.assign(items, { length: items.length }),
  } as unknown as DataTransfer
}

describe('clipboardFiles', () => {
  it('reads Safari files and Chromium items without duplicate attachments', () => {
    const safari = fakeFile('safari.png')
    expect(clipboardFiles(transfer([safari], []))).toEqual([safari])

    const chromium = fakeFile('chrome.png')
    const clone = fakeFile('chrome.png')
    expect(clipboardFiles(transfer([chromium], [{ kind: 'file', getAsFile: () => clone }]))).toEqual([chromium])
  })

  it('ignores non-file clipboard items', () => {
    expect(clipboardFiles(transfer([], [{ kind: 'string', getAsFile: () => null }]))).toEqual([])
  })
})

describe('DraftAttachmentStore', () => {
  it('publishes stable per-session upload, error, add, retain, and remove state', () => {
    const store = new DraftAttachmentStore()
    const listener = vi.fn()
    store.subscribe(listener)
    expect(store.get('s')).toBe(store.get('s'))
    store.setUploading('s', true)
    store.setError('s', 'failed')
    const file = { fileId: 'id', name: 'x', mediaType: 'text/plain', bytes: 1, uri: 'file:///x', expiresAt: 1 } satisfies UploadedFile
    store.add('s', [file])
    expect(store.get('s').files).toEqual([file])
    expect(store.get('s').error).toBeUndefined()
    store.retain('s', () => false)
    store.remove('s', 'id')
    expect(listener).toHaveBeenCalled()
  })
})
