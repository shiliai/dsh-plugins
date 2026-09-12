import { useRef } from 'react'
import Upload from 'lucide-react/dist/esm/icons/upload'
import RefreshCw from 'lucide-react/dist/esm/icons/refresh-cw'
import BookOpen from 'lucide-react/dist/esm/icons/book-open'
import FileText from 'lucide-react/dist/esm/icons/file-text'
import type { PublicBookWithProgress } from '../contracts.ts'
import type { ReadingStore } from './store.ts'
import css from './styles.module.css?dsh-inline'

interface Props {
  store: ReadingStore
  onOpen(book: PublicBookWithProgress): void
}

const FORMAT_LABEL: Record<string, string> = { epub: 'EPUB', pdf: 'PDF', azw3: 'AZW3', mobi: 'MOBI', azw: 'AZW' }

export function LibraryView({ store, onOpen }: Props) {
  const state = store.useSnapshot()
  const fileInput = useRef<HTMLInputElement | null>(null)

  const onFiles = async (files: FileList | null) => {
    if (files === null) return
    for (const file of Array.from(files)) {
      try {
        await store.importFile(file)
      } catch (error) {
        console.error('dsh-reading: import failed', error)
      }
    }
  }

  return (
    <div className={css.libraryRoot}>
      <div className={css.libraryToolbar}>
        <button type="button" className={css.toolButton} onClick={() => fileInput.current?.click()}>
          <Upload size={14} /> 导入
        </button>
        <button type="button" className={css.iconButton} title="刷新" aria-label="刷新书库" onClick={() => void store.refresh()}>
          <RefreshCw size={14} />
        </button>
        <input ref={fileInput} type="file" multiple accept=".epub,.pdf,.azw3,.mobi,.azw" style={{ display: 'none' }}
          onChange={event => { void onFiles(event.target.files); event.target.value = '' }} />
      </div>
      {state.error !== null && <div className={css.libraryError}>{state.error}</div>}
      <div className={css.libraryList}>
        {state.loading && state.books.length === 0 ? <div className={css.panelLoading}>加载中…</div> : null}
        {!state.loading && state.books.length === 0 ? (
          <div className={css.panelLoading}>
            <BookOpen size={28} />
            <p>书库为空。点击「导入」添加 EPUB / PDF 电子书。</p>
          </div>
        ) : state.books.map(book => (
          <button key={book.id} type="button" className={`${css.bookCard} ${state.current?.id === book.id ? css.selected : ''}`} onClick={() => onOpen(book)}>
            <span className={css.bookCover}>
              {book.format === 'pdf' ? <FileText size={22} /> : <BookOpen size={22} />}
            </span>
            <span className={css.bookMeta}>
              <span className={css.bookTitle}>{book.title}</span>
              <span className={css.bookSub}>
                <span className={css.formatBadge}>{FORMAT_LABEL[book.format] ?? book.format.toUpperCase()}</span>
                {book.progress !== undefined && <span>{Math.round(book.progress.percent * 100)}%</span>}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
