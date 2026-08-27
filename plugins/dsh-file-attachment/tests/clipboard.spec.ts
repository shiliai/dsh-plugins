import { describe, expect, it, vi } from 'vitest'
import { claimClipboardFiles } from '../src/client/clipboard.ts'
import { handleAttachmentPaste } from '../src/client/AttachmentControls.tsx'

describe('claimClipboardFiles', () => {
  it('claims file paste events before native image handlers can receive them', () => {
    const file = new File(['image'], 'clipboard.png', { type: 'image/png' })
    const preventDefault = vi.fn()
    const stopImmediatePropagation = vi.fn()

    const files = claimClipboardFiles({
      clipboardData: dataTransfer([file]),
      preventDefault,
      stopImmediatePropagation,
    })

    expect(files).toEqual([file])
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(stopImmediatePropagation).toHaveBeenCalledOnce()
  })

  it('leaves text-only paste events untouched', () => {
    const preventDefault = vi.fn()
    const stopImmediatePropagation = vi.fn()

    expect(claimClipboardFiles({
      clipboardData: dataTransfer([]),
      preventDefault,
      stopImmediatePropagation,
    })).toEqual([])
    expect(preventDefault).not.toHaveBeenCalled()
    expect(stopImmediatePropagation).not.toHaveBeenCalled()
  })

  it.each([
    ['the composer is not plain', 'streaming', false, 'Files can only be attached while composing a message.'],
    ['another upload is in progress', 'plain', true, 'Wait for the current file upload to finish before attaching more files.'],
  ])('claims file paste and reports an error when %s', (_reason, phase, uploading, expectedError) => {
    const textarea = new ComposerTextarea()
    const preventDefault = vi.fn()
    const stopImmediatePropagation = vi.fn()
    const addFiles = vi.fn()
    const reportError = vi.fn()

    handleAttachmentPaste({
      target: textarea,
      clipboardData: dataTransfer([new File(['image'], 'clipboard.png', { type: 'image/png' })]),
      preventDefault,
      stopImmediatePropagation,
    } as unknown as ClipboardEvent, phase, uploading, addFiles, reportError)

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(stopImmediatePropagation).toHaveBeenCalledOnce()
    expect(addFiles).not.toHaveBeenCalled()
    expect(reportError).toHaveBeenCalledExactlyOnceWith(expectedError)
  })
})

class ComposerTextarea extends EventTarget {}

Object.defineProperty(globalThis, 'HTMLTextAreaElement', { value: ComposerTextarea, configurable: true })

function dataTransfer(files: File[]): DataTransfer {
  return {
    files: { length: files.length, item: index => files[index] ?? null },
    items: { length: 0 },
  } as DataTransfer
}
