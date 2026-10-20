/**
 * Clipboard access for the vault browser's "Copy path" action.
 *
 * The Async Clipboard API needs a secure context. A GUI served over plain HTTP
 * from a LAN address (a remote DSH host, for example) is not one, so the copy
 * falls back to a hidden textarea and the legacy `execCommand('copy')` path
 * that still works there.
 */
export async function copyText(text: string): Promise<void> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
  if (clipboard !== undefined && typeof clipboard.writeText === 'function' && typeof window !== 'undefined' && window.isSecureContext) {
    try {
      await clipboard.writeText(text)
      return
    } catch {
      // Permission denied or an unfocused document: try the legacy path.
    }
  }
  if (legacyCopy(text)) return
  throw new Error('The browser blocked clipboard access; copy the path from Properties instead.')
}

function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined' || document.body === null) return false
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.setAttribute('aria-hidden', 'true')
  // Off-screen but still focusable: display:none and hidden inputs cannot be
  // selected, and the browser would reject the copy.
  area.style.position = 'fixed'
  area.style.top = '-1000px'
  area.style.opacity = '0'
  document.body.append(area)
  const selection = document.getSelection()
  const previous = selection === null ? null : { range: selection.rangeCount > 0 ? selection.getRangeAt(0) : null }
  try {
    area.select()
    return typeof document.execCommand === 'function' && document.execCommand('copy')
  } catch {
    return false
  } finally {
    area.remove()
    if (previous !== null && previous.range !== null && selection !== null) {
      selection.removeAllRanges()
      selection.addRange(previous.range)
    }
  }
}
