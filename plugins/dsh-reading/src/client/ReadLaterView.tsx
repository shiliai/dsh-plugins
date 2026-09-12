import { useEffect, useRef, useState } from 'react'
import ExternalLink from 'lucide-react/dist/esm/icons/external-link'
import RefreshCw from 'lucide-react/dist/esm/icons/refresh-cw'
import Send from 'lucide-react/dist/esm/icons/send'
import Clock from 'lucide-react/dist/esm/icons/clock'
import type { Article } from '../contracts.ts'
import { readingApi } from './api.ts'
import css from './styles.module.css?dsh-inline'

interface Props {
  onOpen(article: Article): void
}

/** Wallabag-backed read-later list and URL importer. */
export function ReadLaterView({ onOpen }: Props) {
  const [articles, setArticles] = useState<Article[]>([])
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await readingApi.wallabagEntries()
      setArticles(result.articles)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void refresh() }, [])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const value = url.trim()
    if (value === '') return
    setSubmitting(true)
    setError(null)
    try {
      const result = await readingApi.importUrl(value)
      setUrl('')
      setArticles(current => [result.article, ...current.filter(item => item.id !== result.article.id)])
      onOpen(result.article)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const openArticle = async (value: Article) => {
    if (value.extractedHtml === undefined && value.source === 'wallabag') {
      try {
        const result = await readingApi.wallabagEntry(value.id)
        onOpen(result.article)
        return
      } catch { /* open the metadata already available */ }
    }
    onOpen(value)
  }

  return (
    <div className={css.readLaterRoot}>
      <form className={css.readLaterForm} onSubmit={submit}>
        <input className={css.readLaterInput} type="url" value={url} onChange={event => setUrl(event.target.value)}
          placeholder="粘贴文章 URL" aria-label="文章 URL" disabled={submitting} />
        <button className={css.toolButton} type="submit" disabled={submitting || url.trim() === ''}>
          <Send size={13} /> {submitting ? '收藏中…' : '收藏并阅读'}
        </button>
        <button className={css.iconButton} type="button" title="刷新稍后读" aria-label="刷新稍后读" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw size={14} />
        </button>
      </form>
      {error !== null && <div className={css.libraryError} role="alert">{error}</div>}
      <div className={css.readLaterList}>
        {loading && articles.length === 0 ? <div className={css.panelLoading}>加载中…</div> : null}
        {!loading && articles.length === 0 ? <div className={css.panelLoading}><Clock size={26} /><p>暂无稍后读。粘贴 URL 收藏一篇文章。</p></div> : null}
        {articles.map(article => (
          <button key={article.id} type="button" className={css.articleCard} onClick={() => void openArticle(article)}>
            <span className={css.articleMeta}>
              <span className={css.articleTitle}>{article.title || article.url}</span>
              <span className={css.articleSub}>{article.domain ?? article.url}{article.readingTimeMin ? ` · ${article.readingTimeMin} 分钟` : ''}</span>
            </span>
            <ExternalLink size={14} />
          </button>
        ))}
      </div>
    </div>
  )
}

interface ReaderProps { article: Article }

/** Minimal article reader. HTML is sanitized by the server adapter before delivery. */
export function ArticleReader({ article }: ReaderProps) {
  const [progress, setProgress] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    let active = true
    void readingApi.progress().then(result => {
      const saved = result.progress[article.id]
      if (active && saved?.locator.type === 'article') setProgress(saved.locator.scrollRatio)
    }).catch(() => { /* progress is best effort */ })
    return () => { active = false }
  }, [article.id])
  const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const node = event.currentTarget
    const max = node.scrollHeight - node.clientHeight
    const ratio = max > 0 ? Math.min(1, Math.max(0, node.scrollTop / max)) : 0
    setProgress(ratio)
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      void readingApi.setProgress(article.id, { type: 'article', scrollRatio: ratio }, ratio)
    }, 800)
  }
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current) }, [])

  return (
    <div className={css.articleReader}>
      <header className={css.articleToolbar}>
        <span className={css.readerTitle} title={article.title}>{article.title}</span>
        <a className={css.articleLink} href={article.url} target="_blank" rel="noreferrer"><ExternalLink size={13} /> 原文</a>
      </header>
      <div className={css.articleContent} onScroll={onScroll}>
        {article.extractedHtml ? <div dangerouslySetInnerHTML={{ __html: article.extractedHtml }} /> : <p>正文提取中，暂时请打开原文阅读。</p>}
      </div>
      <footer className={css.readerProgress}><div className={css.readerProgressTrack}><div className={css.readerProgressFill} style={{ width: `${Math.round(progress * 1000) / 10}%` }} /></div><span className={css.readerProgressText}>{Math.round(progress * 100)}%</span></footer>
    </div>
  )
}
