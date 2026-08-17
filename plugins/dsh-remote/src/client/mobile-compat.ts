const MARKERS = {
  frame: 'data-dsh-remote-mobile-frame',
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
  }
}

function markConversation(document: Document, marked: Set<Element>): void {
  for (const scroll of document.querySelectorAll<HTMLElement>('[data-conversation-scroll]')) {
    const conversation = scroll.parentElement
    if (conversation === null || !conversation.hasAttribute('data-phase')) continue
    mark(conversation, MARKERS.conversation, marked)
    mark(conversation.querySelector('[role="banner"]'), MARKERS.header, marked)
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

export function installMobileCompatibility(document: Document = window.document): () => void {
  const marked = new Set<Element>()
  let scheduled = false
  const sync = (): void => {
    scheduled = false
    syncMobileCompatibility(document, marked)
  }
  const schedule = (): void => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(sync)
  }

  sync()
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true })

  return () => {
    observer.disconnect()
    for (const element of marked) {
      for (const marker of Object.values(MARKERS)) element.removeAttribute(marker)
    }
    marked.clear()
  }
}
