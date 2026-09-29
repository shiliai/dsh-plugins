import { useEffect, useRef, useState } from 'react'
import FileText from 'lucide-react/dist/esm/icons/file-text'
import Search from 'lucide-react/dist/esm/icons/search'
import type { NoteSearchResult } from '../contracts.ts'
import { vaultApi, VaultApiError } from './api.ts'
import css from './styles.module.css?dsh-inline'

interface Props {
  openNote(path: string): void
  close(): void
}

/**
 * Quick note opener for the workbench "+" tab button. Searches the vault live
 * on the server (not the rendered tree), so a note created moments ago by a
 * conversation is openable even before the tree picks it up.
 */
export function NoteQuickOpen({ openNote, close }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<NoteSearchResult[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const trimmed = query.trim()
  useEffect(() => {
    if (trimmed === '') { setResults(null); setError(null); return }
    let cancelled = false
    const timer = window.setTimeout(() => {
      vaultApi.search(trimmed)
        .then(({ results: found }) => {
          if (!cancelled) { setResults(found); setError(null) }
        })
        .catch(cause => {
          if (!cancelled) setError(cause instanceof VaultApiError ? cause.message : 'Search failed.')
        })
    }, 180)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [trimmed])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); close() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [close])

  const openFirst = (): void => {
    const first = results?.[0]
    if (first === undefined) return
    openNote(first.path)
    close()
  }

  const uniquePaths = [...new Set((results ?? []).map(result => result.path))]

  return (
    <div className={css.quickOpen} role="dialog" aria-label="Quick open note">
      <div className={css.searchBox}>
        <Search size={15} />
        <input
          ref={inputRef}
          value={query}
          placeholder="Search notes to open"
          aria-label="Search notes to open"
          onChange={event => { setQuery(event.target.value) }}
          onKeyDown={event => {
            if (event.key === 'Enter') { event.preventDefault(); openFirst() }
          }}
        />
      </div>
      {error !== null && <div className={css.inlineError} role="alert">{error}</div>}
      <div className={css.quickOpenResults}>
        {uniquePaths.length === 0 && trimmed !== '' && results !== null && <div className={css.emptyDirectory}>No matching notes</div>}
        {trimmed === '' && <div className={css.emptyDirectory}>Type to search note titles and content</div>}
        {uniquePaths.map(path => (
          <button
            key={path}
            className={css.treeRow}
            type="button"
            title={path}
            onClick={() => { openNote(path); close() }}
          ><FileText size={14} /><span>{path}</span></button>
        ))}
      </div>
    </div>
  )
}
