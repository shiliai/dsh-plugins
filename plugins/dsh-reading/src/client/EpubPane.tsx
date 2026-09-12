import { useEffect, useImperativeHandle, useRef } from 'react'
import type { View, FoliateRelocateDetail, FoliateTocItem } from 'foliate-js/view.js'
import { readingApi } from './api.ts'
import type { ReadingPrefs } from './prefs.ts'

export interface EpubPaneHandle {
  goTo(href: string): void
  next(): void
  prev(): void
}

export interface TocEntry { label: string; href: string; depth: number }

export function flattenToc(items: FoliateTocItem[] | undefined, depth = 0): TocEntry[] {
  if (items === undefined) return []
  return items.flatMap(item => [
    { label: item.label, href: item.href, depth },
    ...flattenToc(item.subitems, depth + 1),
  ])
}

export function buildReaderCss(prefs: ReadingPrefs): string {
  const theme = prefs.theme
  return `
    html, body {
      background: ${theme.background} !important;
      color: ${theme.color} !important;
    }
    html { font-size: ${prefs.fontSize}px !important; }
    body {
      line-height: ${prefs.lineHeight} !important;
      font-family: ${prefs.fontFamily} !important;
    }
    a:link, a:visited { color: ${theme.linkColor} !important; }
    pre, code { white-space: pre-wrap !important; word-break: break-word !important; }
  `
}

function applyPrefsToView(view: View, prefs: ReadingPrefs): void {
  view.renderer?.setStyles?.(buildReaderCss(prefs))
  view.renderer?.setAttribute('flow', prefs.flow)
  ;(view as HTMLElement).style.background = prefs.theme.background
}

interface Props {
  bookId: string
  prefs: ReadingPrefs
  /** Restore target: epubcfi string from persisted progress, if any. */
  initialCfi?: string | undefined
  onRelocate(detail: { cfi: string; percent: number; chapterHref: string; chapterLabel: string }): void
  onReady(toc: TocEntry[]): void
  paneRef: React.RefObject<EpubPaneHandle | null>
}

export function EpubPane({ bookId, prefs, initialCfi, onRelocate, onReady, paneRef }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<View | null>(null)
  const onRelocateRef = useRef(onRelocate)
  onRelocateRef.current = onRelocate
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady

  useImperativeHandle(paneRef, () => ({
    goTo: (href) => { void viewRef.current?.goTo(href) },
    next: () => { void viewRef.current?.next() },
    prev: () => { void viewRef.current?.prev() },
  }), [])

  useEffect(() => {
    const view = viewRef.current
    if (view !== null) applyPrefsToView(view, prefs)
  }, [prefs])

  useEffect(() => {
    const container = containerRef.current
    if (container === null) return
    let cancelled = false
    const view = document.createElement('foliate-view') as View
    view.style.width = '100%'
    view.style.height = '100%'
    view.style.display = 'block'

    const onRelocateEvent = (event: Event) => {
      const detail = (event as CustomEvent<FoliateRelocateDetail>).detail
      if (typeof detail.cfi !== 'string') return
      onRelocateRef.current({
        cfi: detail.cfi,
        percent: typeof detail.fraction === 'number' ? detail.fraction : 0,
        chapterHref: detail.tocItem?.href ?? '',
        chapterLabel: detail.tocItem?.label ?? '',
      })
    }
    view.addEventListener('relocate', onRelocateEvent)

    ;(async () => {
      try {
        const blob = await (await fetch(readingApi.bookFileUrl(bookId))).blob()
        if (cancelled) return
        await view.open(blob)
        if (cancelled) return
        viewRef.current = view
        onReadyRef.current(flattenToc(view.book?.toc))
        if (initialCfi !== undefined && initialCfi !== '') await view.goTo(initialCfi)
        else await view.goToTextStart()
      } catch (error) {
        console.error('dsh-reading: failed to open EPUB', error)
      }
    })()

    container.append(view)
    return () => {
      cancelled = true
      view.removeEventListener('relocate', onRelocateEvent)
      view.close()
      view.remove()
      viewRef.current = null
    }
  }, [bookId, initialCfi])

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
}
