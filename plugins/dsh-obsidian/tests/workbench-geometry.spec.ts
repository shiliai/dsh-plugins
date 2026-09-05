import { describe, expect, it } from 'vitest'
import { calculateWorkbenchLayout, clamp } from '../src/client/workbench-geometry.ts'

describe('workbench geometry', () => {
  it('clamps persisted widths and keeps the chat on the right', () => {
    const layout = calculateWorkbenchLayout({ left: 0, top: 40, right: 1440, bottom: 900 }, { tree: 260, editor: 420, preview: 420, chat: 360, gap: 8 })
    expect(layout.chat.right).toBe(1440)
    expect(layout.chat.left).toBe(1080)
    expect(layout.tree.left).toBe(0)
    expect(layout.preview.right).toBe(1072)
    expect(layout.editor.right).toBe(layout.preview.left - 8)
  })

  it('does not return a width below its minimum', () => {
    expect(clamp(-10, 180, 100)).toBe(180)
    const layout = calculateWorkbenchLayout({ left: 0, top: 0, right: 500, bottom: 400 }, { tree: 20, editor: 20, preview: 20, chat: 20, gap: 8 })
    expect(layout.chat.left).toBeGreaterThanOrEqual(220)
    expect(layout.tree.right - layout.tree.left).toBeGreaterThanOrEqual(180)
  })
})
