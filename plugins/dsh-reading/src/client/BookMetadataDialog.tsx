import { useEffect, useState } from 'react'
import Sparkles from 'lucide-react/dist/esm/icons/sparkles'
import type { PublicBookWithProgress } from '../contracts.ts'
import { readingApi } from './api.ts'
import css from './styles.module.css?dsh-inline'

export interface MetadataFormValues {
  title: string
  author: string
  tags: string
  summary: string
}

interface Props {
  book: PublicBookWithProgress
  /** Generates a summary with the current conversation's LLM; absent hides the button. */
  generateSummary?: (book: PublicBookWithProgress) => Promise<string>
  /** Receives the updated book after a successful save so the library list refreshes in place. */
  onSaved(book: PublicBookWithProgress): void
  onClose(): void
}

function splitTags(value: string): string[] {
  return value.split(/[,，]/u).map(tag => tag.trim()).filter(tag => tag !== '')
}

/**
 * Metadata + calibre upload dialog for one local book (M5b/M5c). Saving writes
 * the metadata.json sidecar so the library list and future uploads pick it up;
 * uploading saves first, then pushes the file and metadata to calibre-web.
 */
export function BookMetadataDialog({ book, generateSummary, onSaved, onClose }: Props) {
  const [title, setTitle] = useState(book.title)
  const [author, setAuthor] = useState(book.author ?? '')
  const [tags, setTags] = useState(book.metadata?.tags?.join(', ') ?? '')
  const [summary, setSummary] = useState(book.metadata?.summary ?? '')
  const [busy, setBusy] = useState<'save' | 'upload' | 'summary' | null>(null)
  const [status, setStatus] = useState<{ kind: 'info' | 'error' | 'success'; text: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    void readingApi.bookMetadata(book.id).then(result => {
      if (cancelled || result.metadata === null) return
      const metadata = result.metadata
      setTitle(current => metadata.title !== undefined && metadata.title !== '' ? metadata.title : current)
      setAuthor(current => metadata.author ?? current)
      setTags(current => metadata.tags !== undefined && metadata.tags.length > 0 ? metadata.tags.join(', ') : current)
      setSummary(current => metadata.summary !== undefined && metadata.summary !== '' ? metadata.summary : current)
    }).catch(() => { /* sidecar is best-effort; keep defaults */ })
    return () => { cancelled = true }
  }, [book.id])

  const values = (): MetadataFormValues => ({ title, author, tags, summary })

  const save = async (): Promise<boolean> => {
    if (title.trim() === '') {
      setStatus({ kind: 'error', text: '书名不能为空。' })
      return false
    }
    setBusy('save')
    setStatus(null)
    try {
      const result = await readingApi.saveBookMetadata(book.id, {
        title: title.trim(),
        author: author.trim(),
        tags: splitTags(tags),
        summary: summary.trim(),
      })
      const saved = result.book
      setTitle(saved.title)
      setAuthor(saved.author ?? '')
      setTags(saved.metadata?.tags?.join(', ') ?? '')
      setSummary(saved.metadata?.summary ?? '')
      onSaved(saved)
      setStatus({ kind: 'success', text: '已保存。' })
      return true
    } catch (error) {
      setStatus({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
      return false
    } finally {
      setBusy(null)
    }
  }

  const upload = async () => {
    if (!(await save())) return
    setBusy('upload')
    setStatus(null)
    try {
      const result = await readingApi.uploadToCalibre({ bookId: book.id, title: title.trim(), author: author.trim(), tags: splitTags(tags), summary: summary.trim() })
      const warnings = result.result.warnings
      setStatus({
        kind: warnings.length > 0 ? 'info' : 'success',
        text: warnings.length > 0 ? `已上传（${result.result.location}）。${warnings.join('')}` : `已上传到 NAS 书库：${result.result.location}`,
      })
    } catch (error) {
      setStatus({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(null)
    }
  }

  const generate = async () => {
    if (generateSummary === undefined) return
    setBusy('summary')
    setStatus({ kind: 'info', text: '正在用当前对话生成概要…' })
    try {
      const text = await generateSummary(book)
      setSummary(text.trim())
      setStatus({ kind: 'success', text: '概要已生成，确认后请保存或上传。' })
    } catch (error) {
      setStatus({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={css.dialogBackdrop} onClick={onClose}>
      <div className={css.dialog} role="dialog" aria-label="书籍元数据" onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
        <h3 className={css.dialogTitle}>元数据与上传</h3>
        <p className={css.dialogHint}>{book.title} · {book.format.toUpperCase()}</p>
        <label className={css.dialogLabel}>书名</label>
        <input className={css.dialogInput} value={title} onChange={event => setTitle(event.target.value)} />
        <label className={css.dialogLabel}>作者</label>
        <input className={css.dialogInput} value={author} onChange={event => setAuthor(event.target.value)} />
        <label className={css.dialogLabel}>标签（逗号分隔）</label>
        <input className={css.dialogInput} value={tags} onChange={event => setTags(event.target.value)} />
        <label className={css.dialogLabel}>概要</label>
        <textarea className={css.dialogInput} rows={7} value={summary} onChange={event => setSummary(event.target.value)} />
        {status !== null && <p className={status.kind === 'error' ? css.dialogError : css.dialogStatus}>{status.text}</p>}
        <div className={css.dialogActions}>
          {generateSummary !== undefined && (
            <button type="button" className={css.toolButton} disabled={busy !== null} onClick={() => void generate()}>
              <Sparkles size={13} /> {busy === 'summary' ? '生成中…' : '用对话生成概要'}
            </button>
          )}
          <span className={css.dialogSpacer} />
          <button type="button" className={css.toolButton} disabled={busy !== null} onClick={() => void save()}>{busy === 'save' ? '保存中…' : '保存'}</button>
          <button type="button" className={css.toolButton} disabled={busy !== null} onClick={() => void upload()}>{busy === 'upload' ? '上传中…' : '上传到 NAS 书库'}</button>
          <button type="button" className={css.toolButton} disabled={busy !== null} onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  )
}
