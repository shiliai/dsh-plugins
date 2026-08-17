const MARKERS = {
  frame: 'data-dsh-remote-mobile-frame',
  sessionActive: 'data-dsh-remote-mobile-session-active',
  sidebar: 'data-dsh-remote-mobile-sidebar',
  center: 'data-dsh-remote-mobile-center',
  details: 'data-dsh-remote-mobile-details',
  conversation: 'data-dsh-remote-mobile-conversation',
  header: 'data-dsh-remote-mobile-header',
  composer: 'data-dsh-remote-mobile-composer',
  composerCard: 'data-dsh-remote-mobile-composer-card',
  composerRow: 'data-dsh-remote-mobile-composer-row',
  composerTools: 'data-dsh-remote-mobile-composer-tools',
  composerTrailing: 'data-dsh-remote-mobile-composer-trailing',
  composerFooter: 'data-dsh-remote-mobile-composer-footer',
} as const

type Marker = typeof MARKERS[keyof typeof MARKERS]

const SIDEBAR_COLLAPSE_LABELS = new Set(['Collapse sidebar', '收起侧边栏'])

export function collapseMobileSidebar(document: Document): boolean {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label]')]
    .find(candidate => SIDEBAR_COLLAPSE_LABELS.has(candidate.getAttribute('aria-label') ?? ''))
  if (button === undefined) return false
  button.click()
  return true
}

function mark(element: Element | null | undefined, marker: Marker, marked: Set<Element>): void {
  if (element === null || element === undefined) return
  element.setAttribute(marker, '')
  marked.add(element)
}

function markFrame(document: Document, marked: Set<Element>): void {
  for (const overlay of document.querySelectorAll<HTMLElement>('[data-shell-overlay]')) {
    const frame = overlay.parentElement
    if (frame === null) continue
    mark(frame, MARKERS.frame, marked)
    mark(frame.children[0], MARKERS.sidebar, marked)
    mark(frame.children[1], MARKERS.center, marked)
    mark(frame.children[2], MARKERS.details, marked)
    if (frame.querySelector('[data-phase="active"]') === null) {
      frame.removeAttribute(MARKERS.sessionActive)
    } else {
      mark(frame, MARKERS.sessionActive, marked)
    }
  }
}

function markConversation(document: Document, marked: Set<Element>): void {
  for (const scroll of document.querySelectorAll<HTMLElement>('[data-conversation-scroll]')) {
    const conversation = scroll.parentElement
    if (conversation === null || !conversation.hasAttribute('data-phase')) continue
    mark(conversation, MARKERS.conversation, marked)
    mark(conversation.querySelector('header, [role="banner"]'), MARKERS.header, marked)
  }
}

function markComposer(document: Document, marked: Set<Element>): void {
  for (const seat of document.querySelectorAll<HTMLElement>('[data-composer-seat]')) {
    const textarea = seat.querySelector('textarea')
    const card = textarea?.parentElement?.parentElement?.parentElement
    const composer = card?.parentElement
    if (card == null || composer == null || !seat.contains(composer)) continue

    const row = card.lastElementChild
    if (row === null || row.querySelector('button') === null) continue

    mark(composer, MARKERS.composer, marked)
    mark(card, MARKERS.composerCard, marked)
    mark(row, MARKERS.composerRow, marked)
    mark(row.firstElementChild, MARKERS.composerTools, marked)
    mark(row.lastElementChild, MARKERS.composerTrailing, marked)

    for (const child of composer.children) {
      if (child !== card) mark(child, MARKERS.composerFooter, marked)
    }
  }
}

export function syncMobileCompatibility(document: Document, marked: Set<Element>): void {
  markFrame(document, marked)
  markConversation(document, marked)
  markComposer(document, marked)
}

export function syncMobileSessionCollapse(
  document: Document,
  activeFrames: Set<Element>,
  mobile: boolean,
): void {
  if (!mobile) {
    activeFrames.clear()
    return
  }
  for (const frame of document.querySelectorAll<HTMLElement>(`[${MARKERS.frame}]`)) {
    const active = frame.hasAttribute(MARKERS.sessionActive)
    if (active && !activeFrames.has(frame)) {
      const collapsed = frame.hasAttribute('data-sidebar-collapsed')
      if (collapsed || collapseMobileSidebar(document)) activeFrames.add(frame)
    } else if (!active) {
      activeFrames.delete(frame)
    }
  }
}

export function clearMobileCompatibility(marked: Set<Element>): void {
  for (const element of marked) {
    for (const marker of Object.values(MARKERS)) element.removeAttribute(marker)
  }
  marked.clear()
}

export function installMobileCompatibility(document: Document = window.document): () => void {
  const marked = new Set<Element>()
  const activeFrames = new Set<Element>()
  const mobileMedia = document.defaultView?.matchMedia('(max-width: 640px)')
  let scheduled = false
  let disposed = false
  const sync = (): void => {
    scheduled = false
    if (disposed) return
    syncMobileCompatibility(document, marked)
    syncMobileSessionCollapse(document, activeFrames, mobileMedia?.matches ?? false)
  }
  const schedule = (): void => {
    if (scheduled || disposed) return
    scheduled = true
    queueMicrotask(sync)
  }

  sync()
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-phase'],
  })
  mobileMedia?.addEventListener('change', schedule)

  return () => {
    disposed = true
    observer.disconnect()
    mobileMedia?.removeEventListener('change', schedule)
    clearMobileCompatibility(marked)
    activeFrames.clear()
  }
}
