import { createPortal } from 'react-dom'
import { useEffect, useRef, useState } from 'react'
import X from 'lucide-react/dist/esm/icons/x'
import Library from 'lucide-react/dist/esm/icons/library'
import Clock from 'lucide-react/dist/esm/icons/clock'
import PenLine from 'lucide-react/dist/esm/icons/pen-line'
import PanelRightClose from 'lucide-react/dist/esm/icons/panel-right-close'
import type { BookWithProgress } from '../contracts.ts'
import type { ReadingStore } from './store.ts'
import { LibraryView } from './LibraryView.tsx'
import { ReaderView } from './ReaderView.tsx'
import { findConversationAnchor, type ConversationAnchor } from './workbench-anchor.ts'
import css from './styles.module.css?dsh-inline'

type LeftTab = 'library' | 'readlater' | 'annotations'

const TAB_LABEL: Record<LeftTab, string> = { library: '书库', readlater: '稍后读', annotations: '批注' }
const CHAT_RESERVE_WIDTH = 400

interface Props {
  store: ReadingStore
  close(): void
}

export function Workbench({ store, close }: Props) {
  const state = store.useSnapshot()
  const [anchor, setAnchor] = useState<ConversationAnchor | null>(() => findConversationAnchor())
  const [tab, setTab] = useState<LeftTab>('library')
  const [leftVisible, setLeftVisible] = useState(true)
  const originalMargin = useRef<{ element: HTMLElement; left: string } | null>(null)

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
  const top = headerRect?.bottom ?? rootRect.top
  const height = rootRect.bottom - top
  const compact = window.innerWidth < 900

  // Reserve the right strip for the native conversation (chat dock).
  if (originalMargin.current?.element !== anchor.viewArea) {
    const previous = originalMargin.current
    if (previous !== null && previous.element.isConnected) previous.element.style.marginLeft = previous.left
    originalMargin.current = { element: anchor.viewArea, left: anchor.viewArea.style.marginLeft }
  }
  const chatWidth = compact ? 0 : Math.min(CHAT_RESERVE_WIDTH, Math.round(window.innerWidth * 0.4))
  anchor.viewArea.style.marginLeft = compact ? '0px' : `${chatWidth}px`

  const onOpenBook = (book: BookWithProgress) => {
    store.flushProgress()
    store.openBook(book)
  }

  return createPortal(
    <div className={css.workbenchRoot} data-dsh-reading-workbench>
      {/* Left column: sources */}
      <section className={css.leftColumn} style={{ display: leftVisible && !compact ? 'flex' : 'none', top, height }}>
        <nav className={css.leftTabs}>
          {(Object.keys(TAB_LABEL) as LeftTab[]).map(key => (
            <button key={key} type="button" className={`${css.leftTab} ${tab === key ? css.selected : ''}`} onClick={() => setTab(key)}>
              {key === 'library' ? <Library size={13} /> : key === 'readlater' ? <Clock size={13} /> : <PenLine size={13} />}
              {TAB_LABEL[key]}
            </button>
          ))}
        </nav>
        <div className={css.leftBody}>
          {tab === 'library' ? <LibraryView store={store} onOpen={onOpenBook} /> : (
            <div className={css.panelLoading}>
              {tab === 'readlater' ? '稍后读（Wallabag）将在 M4 接入。' : '批注中心将在 M3 接入。'}
            </div>
          )}
        </div>
      </section>

      {/* Middle column: reader */}
      <section className={css.readerColumn} style={{ left: leftVisible && !compact ? 264 : 8, right: compact ? 8 : chatWidth + 8, top, height }}>
        {state.current === null ? (
          <div className={css.readerEmpty}>
            <p>📖 从左侧书库选择一本书开始阅读</p>
            <p className={css.readerEmptyHint}>右栏为当前对话，阅读时选中文本即可与 agent 互动（M3）。</p>
          </div>
        ) : (
          <ReaderView key={state.current.id} book={state.current} store={store} />
        )}
      </section>

      {/* Chrome */}
      <div className={css.workbenchChrome} style={{ top }}>
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
