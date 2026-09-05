export interface WorkbenchRect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface WorkbenchWidths {
  tree: number
  editor: number
  preview: number
  chat: number
  gap: number
}

export interface WorkbenchLayout {
  tree: WorkbenchRect
  editor: WorkbenchRect
  preview: WorkbenchRect
  chat: WorkbenchRect
  chatMarginLeft: number
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

export function calculateWorkbenchLayout(rect: WorkbenchRect, widths: WorkbenchWidths): WorkbenchLayout {
  const total = Math.max(0, rect.right - rect.left)
  const gap = Math.max(0, widths.gap)
  const chat = clamp(widths.chat, 280, Math.max(280, total - 420))
  const content = Math.max(0, total - chat)
  const tree = clamp(widths.tree, 180, Math.max(180, content - 560))
  const editor = clamp(widths.editor, 240, Math.max(240, content - tree - 300 - gap * 2))
  const preview = Math.max(240, content - tree - editor - gap * 2)
  const treeRight = rect.left + tree
  const editorLeft = treeRight + gap
  const editorRight = editorLeft + editor
  const previewLeft = editorRight + gap
  const chatLeft = rect.right - chat
  return {
    tree: { left: rect.left, top: rect.top, right: treeRight, bottom: rect.bottom },
    editor: { left: editorLeft, top: rect.top, right: editorRight, bottom: rect.bottom },
    preview: { left: previewLeft, top: rect.top, right: chatLeft - gap, bottom: rect.bottom },
    chat: { left: chatLeft, top: rect.top, right: rect.right, bottom: rect.bottom },
    chatMarginLeft: content,
  }
}
