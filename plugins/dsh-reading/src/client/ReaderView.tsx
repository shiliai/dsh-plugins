import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import X from 'lucide-react/dist/esm/icons/x'
import List from 'lucide-react/dist/esm/icons/list'
import Minus from 'lucide-react/dist/esm/icons/minus'
import Plus from 'lucide-react/dist/esm/icons/plus'
import Moon from 'lucide-react/dist/esm/icons/moon'
import Sun from 'lucide-react/dist/esm/icons/sun'
import BookOpen from 'lucide-react/dist/esm/icons/book-open'
import ChevronLeft from 'lucide-react/dist/esm/icons/chevron-left'
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right'
import ScrollText from 'lucide-react/dist/esm/icons/scroll-text'
import Columns2 from 'lucide-react/dist/esm/icons/columns-2'
import type { BookWithProgress } from '../contracts.ts'
import type { ReadingStore } from './store.ts'
import { EpubPane, type EpubPaneHandle, type TocEntry } from './EpubPane.tsx'
import { PdfPane, type PdfPaneHandle } from './PdfPane.tsx'
import { loadPrefs, savePrefs, READING_THEMES, type ReadingPrefs, type ThemeName } from './prefs.ts'
import css from './styles.module.css?dsh-inline'

interface Props {
  book: BookWithProgress
  store: ReadingStore
}

const THEME_ORDER: ThemeName[] = ['dark', 'paper', 'sepia', 'green']
const THEME_LABEL: Record<ThemeName, string> = { dark: '夜间', paper: '白纸', sepia: '羊皮纸', green: '护眼' }

export function ReaderView({ book, store }: Props) {
  const [prefs, setPrefs] = useState<ReadingPrefs>(() => loadPrefs())
  const [tocOpen, setTocOpen] = useState(false)
  const [toc, setToc] = useState<TocEntry[]>([])
  const [chapterLabel, setChapterLabel] = useState('')
  const [percent, setPercent] = useState(book.progress?.percent ?? 0)
  const epubRef = useRef<EpubPaneHandle | null>(null)
  const pdfRef = useRef<PdfPaneHandle | null>(null)
  const bookRef = useRef(book)
  bookRef.current = book

  const patchPrefs = useCallback((patch: Partial<ReadingPrefs>) => {
    setPrefs(current => {
      const next = { ...current, ...patch }
      savePrefs(next)
      return next
    })
  }, [])

  const cycleTheme = useCallback(() => {
    setPrefs(current => {
      const nextName = THEME_ORDER[(THEME_ORDER.indexOf(current.themeName) + 1) % THEME_ORDER.length] ?? 'dark'
      const next: ReadingPrefs = { ...current, themeName: nextName, theme: READING_THEMES[nextName] }
      savePrefs(next)
      return next
    })
  }, [])

  const onEpubRelocate = useCallback((detail: { cfi: string; percent: number; chapterHref: string; chapterLabel: string }) => {
    setPercent(detail.percent)
    setChapterLabel(detail.chapterLabel)
    store.reportProgress(bookRef.current.id, { type: 'epub', cfi: detail.cfi, chapterHref: detail.chapterHref }, detail.percent)
  }, [store])

  const onPdfProgress = useCallback((page: number, scrollRatio: number, ratio: number, pageCount: number) => {
    setPercent(ratio)
    setChapterLabel(`第 ${page}/${pageCount} 页`)
    store.reportProgress(bookRef.current.id, { type: 'pdf', page, scrollRatio }, ratio)
  }, [store])

  const initialCfi = book.progress?.locator.type === 'epub' ? book.progress.locator.cfi : undefined
  const initialPage = book.progress?.locator.type === 'pdf' ? book.progress.locator.page : undefined

  const unsupported = book.format === 'azw3' || book.format === 'mobi' || book.format === 'azw'

  const tocList = useMemo(() => toc, [toc])

  return (
    <div className={css.readerShell} style={{ background: prefs.theme.background, color: prefs.theme.color }}>
      <header className={css.readerToolbar}>
        <span className={css.readerTitle} title={book.title}>{book.title}</span>
        <span className={css.readerChapter}>{chapterLabel}</span>
        <div className={css.readerActions}>
          <button type="button" className={css.iconButton} title="目录" aria-label="目录" onClick={() => setTocOpen(value => !value)}><List size={15} /></button>
          <button type="button" className={css.iconButton} title="减小字号" aria-label="减小字号" onClick={() => patchPrefs({ fontSize: Math.max(12, prefs.fontSize - 1) })}><Minus size={15} /></button>
          <button type="button" className={css.iconButton} title="增大字号" aria-label="增大字号" onClick={() => patchPrefs({ fontSize: Math.min(28, prefs.fontSize + 1) })}><Plus size={15} /></button>
          <button type="button" className={css.iconButton} title={`主题：${THEME_LABEL[prefs.themeName].trim()}`} aria-label="切换主题" onClick={cycleTheme}>
            {prefs.themeName === 'dark' ? <Moon size={15} /> : <Sun size={15} />}
          </button>
          <button type="button" className={css.iconButton} title={prefs.flow === 'paginated' ? '切换为滚动' : '切换为分页'} aria-label="切换翻页模式"
            onClick={() => patchPrefs({ flow: prefs.flow === 'paginated' ? 'scrolled' : 'paginated' })}>
            {prefs.flow === 'paginated' ? <ScrollText size={15} /> : <Columns2 size={15} />}
          </button>
        </div>
      </header>

      <div className={css.readerBody}>
        {tocOpen && (
          <nav className={css.tocDrawer} style={{ background: prefs.theme.background, color: prefs.theme.color }} aria-label="目录">
            <div className={css.tocHeader}>
              <span>目录</span>
              <button type="button" className={css.iconButton} aria-label="关闭目录" onClick={() => setTocOpen(false)}><X size={14} /></button>
            </div>
            <div className={css.tocList}>
              {tocList.length === 0 ? <div className={css.panelLoading}>本书没有目录。</div> : tocList.map((item, index) => (
                <button key={`${item.href}-${index}`} type="button" className={css.tocItem} style={{ paddingLeft: 10 + item.depth * 14 }}
                  onClick={() => { epubRef.current?.goTo(item.href); setTocOpen(false) }}>
                  {item.label}
                </button>
              ))}
            </div>
          </nav>
        )}

        <div className={css.readerContent}>
          {unsupported ? (
            <div className={css.panelLoading}>
              <BookOpen size={28} />
              <p>{book.format.toUpperCase()} 格式需要转换后阅读（M3：SSH ebook-convert 转换管道）。</p>
            </div>
          ) : book.format === 'pdf' ? (
            <PdfPane key={book.id} bookId={book.id} prefs={prefs} initialPage={initialPage} onProgress={onPdfProgress} paneRef={pdfRef} />
          ) : (
            <EpubPane key={book.id} bookId={book.id} fileName={book.fileName} prefs={prefs} initialCfi={initialCfi} onRelocate={onEpubRelocate} onReady={setToc} paneRef={epubRef} />
          )}
          {book.format === 'epub' && (
            <div className={css.readerNav}>
              <button type="button" className={css.iconButton} aria-label="上一页" onClick={() => epubRef.current?.prev()}><ChevronLeft size={16} /></button>
              <button type="button" className={css.iconButton} aria-label="下一页" onClick={() => epubRef.current?.next()}><ChevronRight size={16} /></button>
            </div>
          )}
        </div>
      </div>

      <footer className={css.readerProgress}>
        <div className={css.readerProgressTrack}>
          <div className={css.readerProgressFill} style={{ width: `${Math.round(percent * 1000) / 10}%`, background: prefs.theme.linkColor }} />
        </div>
        <span className={css.readerProgressText}>{Math.round(percent * 100)}%</span>
      </footer>
    </div>
  )
}
