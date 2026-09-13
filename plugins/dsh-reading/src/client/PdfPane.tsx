import { useEffect, useImperativeHandle, useRef } from 'react'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
// The DSH client bundle is a single CJS file served through the module loader,
// so the worker ships inline as source and runs from a same-origin blob URL.
import pdfWorkerSource from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?dsh-raw'
import { readingApi } from './api.ts'
import type { ReadingPrefs } from './prefs.ts'

pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([pdfWorkerSource], { type: 'text/javascript' }))

export interface PdfPaneHandle {
  goToPage(page: number): void
}

interface Props {
  bookId: string
  prefs: ReadingPrefs
  initialPage?: number | undefined
  onProgress(page: number, scrollRatio: number, percent: number, pageCount: number): void
  paneRef: React.RefObject<PdfPaneHandle | null>
}

interface PdfDoc {
  numPages: number
  getPage(page: number): Promise<PdfPage>
}

interface PdfPage {
  getViewport(options: { scale: number }): { width: number; height: number }
  render(options: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void> }
}

const RENDER_AHEAD = 2
const RENDER_BEHIND = 1

export function PdfPane({ bookId, prefs, initialPage, onProgress, paneRef }: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const docRef = useRef<PdfDoc | null>(null)
  const pagesRef = useRef<Map<number, HTMLElement>>(new Map())
  const renderedRef = useRef(new Set<number>())
  const renderingRef = useRef(new Set<number>())
  const initialScrollDone = useRef(false)
  const onProgressRef = useRef(onProgress)
  onProgressRef.current = onProgress

  const renderPage = async (pageNumber: number) => {
    const doc = docRef.current
    if (doc === null || renderedRef.current.has(pageNumber) || renderingRef.current.has(pageNumber)) return
    renderingRef.current.add(pageNumber)
    try {
      const host = pagesRef.current.get(pageNumber)
      if (host === undefined || !host.isConnected) return
      const page = await doc.getPage(pageNumber)
      const viewport = page.getViewport({ scale: 1 })
      const containerWidth = host.clientWidth || 800
      const scale = containerWidth / viewport.width
      const scaled = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(scaled.width)
      canvas.height = Math.floor(scaled.height)
      canvas.style.display = 'block'
      const context = canvas.getContext('2d')
      if (context === null) return
      host.style.height = `${scaled.height}px`
      host.replaceChildren(canvas)
      await page.render({ canvasContext: context, viewport: scaled }).promise
      renderedRef.current.add(pageNumber)
    } finally {
      renderingRef.current.delete(pageNumber)
    }
  }

  const updateVisible = () => {
    const container = scrollRef.current
    const doc = docRef.current
    if (container === null || doc === null) return
    const top = container.scrollTop - 400
    const bottom = container.scrollTop + container.clientHeight + 400
    // derive current page
    let current = 1
    for (let page = 1; page <= doc.numPages; page++) {
      const host = pagesRef.current.get(page)
      if (host === undefined) continue
      if (host.offsetTop + host.offsetHeight > container.scrollTop + 4) { current = page; break }
      current = page
    }
    for (let page = Math.max(1, current - RENDER_BEHIND); page <= Math.min(doc.numPages, current + RENDER_AHEAD); page++) {
      void renderPage(page)
    }
    const scrollable = container.scrollHeight - container.clientHeight
    const ratio = scrollable > 0 ? container.scrollTop / scrollable : 0
    onProgressRef.current(current, ratio, doc.numPages > 1 ? (current - 1 + ratio) / doc.numPages : 0, doc.numPages)
  }

  useImperativeHandle(paneRef, () => ({
    goToPage: (page) => {
      const host = pagesRef.current.get(page)
      const container = scrollRef.current
      if (host !== undefined && container !== null) container.scrollTop = host.offsetTop + 2
    },
  }), [])

  useEffect(() => {
    const container = scrollRef.current
    if (container !== null) container.style.background = prefs.theme.background
  }, [prefs])

  useEffect(() => {
    const container = scrollRef.current
    if (container === null) return
    let cancelled = false
    let doc: PdfDoc | null = null
    // pdf.js v6: destroy() lives on the loading task, not the document proxy.
    let loadingTask: { destroy(): Promise<void> } | null = null

    ;(async () => {
      try {
        const data = await (await fetch(readingApi.bookFileUrl(bookId))).arrayBuffer()
        if (cancelled) return
        const loading = (pdfjs.getDocument as (params: Record<string, unknown>) => { promise: Promise<unknown>; destroy(): Promise<void> })({ data, isEvalSupported: false })
        loadingTask = loading
        doc = await loading.promise as unknown as PdfDoc
        if (cancelled) { void loading.destroy(); return }
        docRef.current = doc
        const fragment = document.createDocumentFragment()
        for (let page = 1; page <= doc.numPages; page++) {
          const host = document.createElement('div')
          host.dataset.page = String(page)
          host.style.minHeight = '60vh'
          host.style.margin = '0 auto 12px'
          host.style.maxWidth = '100%'
          pagesRef.current.set(page, host)
          fragment.append(host)
        }
        container.replaceChildren(fragment)
        container.style.background = prefs.theme.background
        if (initialPage !== undefined && initialPage > 1) {
          requestAnimationFrame(() => {
            const host = pagesRef.current.get(initialPage)
            if (host !== undefined) container.scrollTop = host.offsetTop + 2
            initialScrollDone.current = true
            updateVisible()
          })
        } else {
          initialScrollDone.current = true
          updateVisible()
        }
      } catch (error) {
        console.error('dsh-reading: failed to open PDF', error)
      }
    })()

    const onScroll = () => { if (initialScrollDone.current) updateVisible() }
    container.addEventListener('scroll', onScroll, { passive: true })

    return () => {
      cancelled = true
      container.removeEventListener('scroll', onScroll)
      docRef.current = null
      pagesRef.current.clear()
      renderedRef.current.clear()
      renderingRef.current.clear()
      initialScrollDone.current = false
      if (loadingTask !== null) void loadingTask.destroy()
    }
    // Open the document only when the selected book changes. Progress updates
    // change initialPage, but must not tear down and recreate the PDF view;
    // the captured value is used only for initial restore.
  }, [bookId])

  return <div ref={scrollRef} className="dshReadingPdfHost" style={{ width: '100%', height: '100%', overflowY: 'auto' }} />
}
