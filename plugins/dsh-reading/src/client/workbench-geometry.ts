export interface WorkbenchRect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface ReadingWidths {
  library: number
  chat: number
}

export interface ReadingLayout {
  library: WorkbenchRect
  reader: WorkbenchRect
  chat: WorkbenchRect
  chatMarginLeft: number
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

export const GAP = 8
export const MIN_LIBRARY = 180
export const MIN_READER = 320
export const MIN_CHAT = 280

/**
 * Derive the three reading columns (library / reader / chat) from a single
 * base rect, mirroring dsh-obsidian's workbench-geometry. The chat rect is the
 * strip reserved for the native conversation dock; `chatMarginLeft` is the
 * horizontal shift applied to the dock's view area so all three columns share
 * the same top/bottom/left reference frame.
 */
export function calculateReadingLayout(rect: WorkbenchRect, widths: ReadingWidths, libraryVisible: boolean): ReadingLayout {
  const total = Math.max(0, rect.right - rect.left)
  const chatWidth = clamp(widths.chat, MIN_CHAT, Math.max(MIN_CHAT, total - MIN_READER - GAP))
  const chatLeft = rect.right - chatWidth
  const libraryWidth = libraryVisible ? clamp(widths.library, MIN_LIBRARY, Math.max(MIN_LIBRARY, chatLeft - rect.left - MIN_READER - GAP)) : 0
  const libraryRight = rect.left + libraryWidth
  const readerLeft = libraryVisible ? libraryRight + GAP : rect.left
  const readerRight = chatLeft - GAP
  return {
    library: { left: rect.left, top: rect.top, right: libraryRight, bottom: rect.bottom },
    reader: { left: readerLeft, top: rect.top, right: Math.max(readerLeft, readerRight), bottom: rect.bottom },
    chat: { left: chatLeft, top: rect.top, right: rect.right, bottom: rect.bottom },
    chatMarginLeft: chatLeft - rect.left,
  }
}
