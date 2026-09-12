import { createPortal } from 'react-dom'
import { useEffect, useRef, useState } from 'react'
import X from 'lucide-react/dist/esm/icons/x'
import Library from 'lucide-react/dist/esm/icons/library'
import Clock from 'lucide-react/dist/esm/icons/clock'
import PenLine from 'lucide-react/dist/esm/icons/pen-line'
import PanelRightClose from 'lucide-react/dist/esm/icons/panel-right-close'
import type { Article, PublicBookWithProgress } from '../contracts.ts'
import type { ReadingStore } from './store.ts'
import { LibraryView } from './LibraryView.tsx'
import { ReaderView } from './ReaderView.tsx'
import { ArticleReader, ReadLaterView } from './ReadLaterView.tsx'
import { findConversationAnchor, type ConversationAnchor } from './workbench-anchor.ts'
import { calculateReadingLayout, MIN_CHAT, MIN_LIBRARY, type ReadingWidths, type WorkbenchRect } from './workbench-geometry.ts'
import css from './styles.module.css?dsh-inline'

type LeftTab = 'library' | 'readlater' | 'annotations'

const TAB_LABEL: Record<LeftTab, string> = { library: '书库', readlater: '稍后读', annotations: '批注' }
const LAYOUT_STORAGE_KEY = 'dsh-reading.layout'
const COMPACT_BREAKPOINT = 900
const DEFAULT_WIDTHS: ReadingWidths = { library: 248, chat: 400 }

interface Props {
  store: ReadingStore
  close(): void
  addArticleContext(article: Article): Promise<void>
  addObsidianReadingContext(): Promise<void>
}

export function Workbench({ store, close, addArticleContext, addObsidianReadingContext }: Props) {
  const state = store.useSnapshot()
  const [anchor, setAnchor] = useState<ConversationAnchor | null>(() => findConversationAnchor())
  const [tab, setTab] = useState<LeftTab>('library')
  const [article, setArticle] = useState<Article | null>(null)
  const [leftVisible, setLeftVisible] = useState(true)
  const [widths, setWidths] = useState<ReadingWidths>(() => loadWidths())
  const originalMargin = useRef<{ element: HTMLElement; left: string } | null>(null)
  const drag = useRef<{ key: keyof ReadingWidths; startX: number; start: number } | null>(null)

  useEffect(() => {
    void store.refresh()
    const observer = new MutationObserver(() => setAnchor(findConversationAnchor()))
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-phase'] })
    const refresh = () => setAnchor(findConversationAnchor())
    window.addEventListener('resize', refresh)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', refresh)
      void store.flushProgress()
    }
  }, [store])

  useEffect(() => { localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(widths)) }, [widths])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [close])

  // Restore the conversation view area when the workbench unmounts.
  useEffect(() => () => {
    const original = originalMargin.current
    if (original !== null && original.element.isConnected) original.element.style.marginLeft = original.left
  }, [])

  if (anchor === null) {
    return createPortal(<div className={css.workbenchUnavailable} role="status">Waiting for the active conversation…</div>, document.body)
  }

  const rootRect = anchor.root.getBoundingClientRect()
  const headerRect = anchor.header?.getBoundingClientRect()
  const rect: WorkbenchRect = {
    left: rootRect.left,
    top: (headerRect && headerRect.height > 0 ? headerRect.bottom : rootRect.top),
    right: rootRect.right,
    bottom: rootRect.bottom,
  }
  const compact = window.innerWidth < COMPACT_BREAKPOINT
  const layout = calculateReadingLayout(rect, widths, leftVisible && !compact)

  // Reserve the right strip for the native conversation (chat dock). All three
  // columns derive from the same base rect, so the dock aligns exactly with
  // the library/reader columns.
  if (originalMargin.current?.element !== anchor.viewArea) {
    const previous = originalMargin.current
    if (previous !== null && previous.element.isConnected) previous.element.style.marginLeft = previous.left
    originalMargin.current = { element: anchor.viewArea, left: anchor.viewArea.style.marginLeft }
  }
  anchor.viewArea.style.marginLeft = compact ? '0px' : `${layout.chatMarginLeft}px`

  const onOpenBook = (book: PublicBookWithProgress) => {
    setArticle(null)
    store.flushProgress()
    store.openBook(book)
  }

  const onOpenArticle = (value: Article) => {
    setArticle(value)
    store.closeBook()
  }

  const beginResize = (key: keyof ReadingWidths, event: React.PointerEvent) => {
    drag.current = { key, startX: event.clientX, start: widths[key] }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const moveResize = (event: React.PointerEvent) => {
    const current = drag.current
    if (current === null) return
    // The library handle sits on the library's right edge (drag right → wider);
    // the chat handle sits on the chat's left edge (drag left → wider).
    const direction = current.key === 'library' ? 1 : -1
    const minimum = current.key === 'library' ? MIN_LIBRARY : MIN_CHAT
    setWidths(value => ({ ...value, [current.key]: Math.max(minimum, current.start + direction * (event.clientX - current.startX)) }))
  }
  const finishResize = () => { drag.current = null }

  const libraryRect = layout.library
  const readerRect = compact ? rect : layout.reader
  const paneStyle = (pane: WorkbenchRect): React.CSSProperties => ({ left: pane.left, top: pane.top, width: pane.right - pane.left, height: pane.bottom - pane.top })

  return createPortal(
    <div className={css.workbenchRoot} data-dsh-reading-workbench>
      {/* Left column: sources */}
      {!compact && leftVisible && (
        <section className={css.leftColumn} style={paneStyle(libraryRect)} aria-label="书库栏">
          <nav className={css.leftTabs}>
            {(Object.keys(TAB_LABEL) as LeftTab[]).map(key => (
              <button key={key} type="button" className={`${css.leftTab} ${tab === key ? css.selected : ''}`} onClick={() => setTab(key)}>
                {key === 'library' ? <Library size={13} /> : key === 'readlater' ? <Clock size={13} /> : <PenLine size={13} />}
                {TAB_LABEL[key]}
              </button>
            ))}
          </nav>
          <div className={css.leftBody}>
            {tab === 'library' ? <LibraryView store={store} onOpen={onOpenBook} /> : tab === 'readlater' ? <ReadLaterView onOpen={onOpenArticle} /> : (
              <div className={css.panelLoading}>批注中心将在 M3 接入。</div>
            )}
          </div>
        </section>
      )}

      {/* Middle column: reader */}
      <section className={css.readerColumn} style={paneStyle(readerRect)} aria-label="阅读栏">
        {article !== null ? <ArticleReader article={article} addArticleContext={addArticleContext} addObsidianReadingContext={addObsidianReadingContext} /> : state.current === null ? (
          <div className={css.readerEmpty}>
            <p>📖 从左侧书库选择一本书开始阅读</p>
            <p className={css.readerEmptyHint}>右栏为当前对话，阅读时选中文本即可与 agent 互动（M3）。</p>
          </div>
        ) : (
          <ReaderView key={state.current.id} book={state.current} store={store} />
        )}
      </section>

      {/* Drag handles between the columns (fixed, so they are never clipped).
          Library handle: right edge of the library column. Chat handle: left
          edge of the reserved chat strip. */}
      {!compact && leftVisible && (
        <div className={css.columnResize} role="separator" aria-label="调整书库栏宽度"
          onPointerDown={event => beginResize('library', event)} onPointerMove={moveResize} onPointerUp={finishResize}
          style={{ left: libraryRect.right - 5, top: rect.top, height: rect.bottom - rect.top }} />
      )}
      {!compact && (
        <div className={css.columnResize} role="separator" aria-label="调整对话栏宽度"
          onPointerDown={event => beginResize('chat', event)} onPointerMove={moveResize} onPointerUp={finishResize}
          style={{ left: layout.chat.left - 5, top: rect.top, height: rect.bottom - rect.top }} />
      )}

      {/* Chrome */}
      <div className={css.workbenchChrome} style={{ left: readerRect.right - 92, top: rect.top + 10 }}>
        <button type="button" className={css.iconButton} title={leftVisible ? '隐藏书库栏' : '显示书库栏'} aria-label="切换书库栏"
          onClick={() => setLeftVisible(value => !value)}>
          <PanelRightClose size={15} style={{ transform: leftVisible ? 'none' : 'rotate(180deg)' }} />
        </button>
        <button type="button" className={css.iconButton} title="关闭阅读工作台" aria-label="关闭阅读工作台" onClick={close}><X size={16} /></button>
      </div>
    </div>,
    document.body,
  )
}

function loadWidths(): ReadingWidths {
  try {
    const value = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) ?? '{}') as Partial<ReadingWidths>
    return { library: finite(value.library, DEFAULT_WIDTHS.library), chat: finite(value.chat, DEFAULT_WIDTHS.chat) }
  } catch {
    return { ...DEFAULT_WIDTHS }
  }
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
