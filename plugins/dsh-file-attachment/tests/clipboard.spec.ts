import { describe, expect, it, vi } from 'vitest'
import { claimClipboardFiles } from '../src/client/clipboard.ts'

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
})

function dataTransfer(files: File[]): DataTransfer {
  return {
    files: { length: files.length, item: index => files[index] ?? null },
    items: { length: 0 },
  } as DataTransfer
}
