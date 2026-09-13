export interface ConversationAnchor {
  root: HTMLElement
  viewArea: HTMLElement
  header: HTMLElement | null
}

function usableRoot(element: HTMLElement): boolean {
  return element.tagName !== 'TEXTAREA' && element.tagName !== 'INPUT' && element.children.length >= 2
}

export function findConversationAnchor(documentRef: Document = document): ConversationAnchor | null {
  const candidates = Array.from(documentRef.querySelectorAll<HTMLElement>('[data-phase]')).filter(usableRoot)
  const root = candidates.find(candidate => candidate.dataset.phase === 'active') ?? candidates[0]
  if (root === undefined) return null
  const children = Array.from(root.children).filter((child): child is HTMLElement => typeof (child as HTMLElement).tagName === 'string')
  const header = children[0] ?? null
  const viewArea = children.find(child => child !== header && (child.querySelector('textarea') !== null || child.scrollHeight > child.clientHeight || child.clientHeight > 0)) ?? children[1]
  return viewArea === undefined ? null : { root, header, viewArea }
}
