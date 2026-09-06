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

export type WorkbenchPaneKey = 'tree' | 'editor' | 'preview' | 'chat'

export type WorkbenchVisibility = Record<WorkbenchPaneKey, boolean>

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

export function calculateWorkbenchLayout(rect: WorkbenchRect, widths: WorkbenchWidths, visibility: WorkbenchVisibility = { tree: true, editor: true, preview: true, chat: true }): WorkbenchLayout {
  const total = Math.max(0, rect.right - rect.left)
  const gap = Math.max(0, widths.gap)
  if (visibility.tree && visibility.editor && visibility.preview && visibility.chat) {
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
  const allKeys: WorkbenchPaneKey[] = ['tree', 'editor', 'preview', 'chat']
  const keys = allKeys.filter(key => visibility[key])
  const minimums: Record<WorkbenchPaneKey, number> = { tree: 180, editor: 240, preview: 240, chat: 280 }
  const available = Math.max(0, total - Math.max(0, keys.length - 1) * gap)
  const preferred = keys.map(key => Math.max(minimums[key], widths[key]))
  const preferredTotal = preferred.reduce((sum, width) => sum + width, 0)
  const scale = 1
  const sizes = new Map<WorkbenchPaneKey, number>(keys.map((key, index) => [key, (preferred[index] ?? minimums[key]) * scale]))
  if (keys.length > 0 && preferredTotal < available) {
    const last = keys.at(-1)
    if (last !== undefined) sizes.set(last, (sizes.get(last) ?? 0) + available - preferredTotal)
  }
  const size = (key: WorkbenchPaneKey): number => sizes.get(key) ?? 0
  const tree = size('tree')
  const editor = size('editor')
  const preview = size('preview')
  const chat = size('chat')
  let cursor = rect.left
  const rectFor = (key: WorkbenchPaneKey): WorkbenchRect => {
    const left = cursor
    const right = left + size(key)
    cursor = right + gap
    return { left, top: rect.top, right, bottom: rect.bottom }
  }
  const emptyRect = (): WorkbenchRect => ({ left: rect.left, top: rect.top, right: rect.left, bottom: rect.bottom })
  const treeRect = visibility.tree ? rectFor('tree') : emptyRect()
  const editorRect = visibility.editor ? rectFor('editor') : emptyRect()
  const previewRect = visibility.preview ? rectFor('preview') : emptyRect()
  const chatRect = visibility.chat ? rectFor('chat') : emptyRect()
  return {
    tree: treeRect,
    editor: editorRect,
    preview: previewRect,
    chat: chatRect,
    chatMarginLeft: visibility.chat ? chatRect.left - rect.left : 0,
  }
}
