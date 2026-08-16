import { useEffect, useState } from 'react'
import Eye from 'lucide-react/dist/esm/icons/eye'
import FilePenLine from 'lucide-react/dist/esm/icons/file-pen-line'
import MessageSquarePlus from 'lucide-react/dist/esm/icons/message-square-plus'
import MoreHorizontal from 'lucide-react/dist/esm/icons/more-horizontal'
import RefreshCw from 'lucide-react/dist/esm/icons/refresh-cw'
import Save from 'lucide-react/dist/esm/icons/save'
import Trash2 from 'lucide-react/dist/esm/icons/trash-2'
import X from 'lucide-react/dist/esm/icons/x'
import { MarkdownPreview } from './MarkdownPreview.tsx'
import type { VaultStore } from './store.ts'
import css from './styles.module.css?dsh-inline'

interface Props {
  store: VaultStore
  inputActions?: { setDraft(text: string): void }
  useInput?: <T>(selector: (state: { draft: string }) => T) => T
}

export function NotePanel({ store, inputActions, useInput }: Props) {
  const state = store.useSnapshot()
  const chatDraft = useInput?.(input => input.draft) ?? ''
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    const interval = window.setInterval(() => { void store.pollActive() }, 3000)
    return () => { window.clearInterval(interval) }
  }, [store])

  const note = state.active
  return (
    <section className={css.panel} aria-label="Note editor">
      <header className={css.panelHeader}>
        <div className={css.noteIdentity}>
          <FilePenLine size={17} />
          <span title={note?.path}>{note?.path ?? 'Opening note'}</span>
          {store.dirty && <i title="Unsaved changes" />}
        </div>
        <div className={css.toolbar}>
          <div className={css.segmented} aria-label="Note mode">
            <button className={state.mode === 'edit' ? css.selected : ''} type="button" title="Edit" aria-label="Edit" onClick={() => { store.setMode('edit') }}><FilePenLine size={15} /></button>
            <button className={state.mode === 'preview' ? css.selected : ''} type="button" title="Preview" aria-label="Preview" onClick={() => { store.setMode('preview') }}><Eye size={15} /></button>
          </div>
          <button
            className={css.iconButton}
            type="button"
            title="Add note to chat"
            aria-label="Add note to chat"
            disabled={note === null || inputActions === undefined}
            onClick={() => {
              if (note !== null && inputActions !== undefined) {
                inputActions.setDraft(`${chatDraft}${chatDraft === '' ? '' : '\n\n'}Please work with the Obsidian note [[${note.path}]].`)
              }
            }}
          ><MessageSquarePlus size={16} /></button>
          <button className={css.iconButton} type="button" title="Save" aria-label="Save" disabled={!store.dirty || state.saving} onClick={() => { void store.save() }}><Save size={16} /></button>
          <div className={css.menuAnchor}>
            <button className={css.iconButton} type="button" title="Note actions" aria-label="Note actions" disabled={note === null} onClick={() => { setMenuOpen(value => !value) }}><MoreHorizontal size={16} /></button>
            {menuOpen && note !== null && (
              <div className={css.actionMenu} role="menu">
                <button type="button" role="menuitem" onClick={() => {
                  setMenuOpen(false)
                  const next = window.prompt('Move or rename note', note.path)
                  if (next !== null && next.trim() !== '' && next !== note.path) void store.renameActive(next)
                }}><RefreshCw size={14} />Move or rename</button>
                <button className={css.danger} type="button" role="menuitem" onClick={() => { setMenuOpen(false); void store.deleteActive() }}><Trash2 size={14} />Delete</button>
              </div>
            )}
          </div>
          <button className={css.iconButton} type="button" title="Close note" aria-label="Close note" onClick={() => { store.closeNote() }}><X size={17} /></button>
        </div>
      </header>

      {state.error !== null && <div className={css.panelError} role="alert">{state.error}</div>}
      {state.loadingNote || note === null
        ? <div className={css.panelLoading}>Opening...</div>
        : state.mode === 'edit'
          ? <textarea className={css.editor} value={state.draft} aria-label={`Edit ${note.path}`} spellCheck onChange={event => { store.setDraft(event.target.value) }} />
          : <article className={css.preview}><MarkdownPreview content={state.draft} notePath={note.path} openNote={path => { void store.openNote(path) }} /></article>}
      <footer className={css.statusBar}>
        <span>{note === null ? '' : `${state.draft.split(/\r?\n/u).length} lines`}</span>
        <span>{state.saving ? 'Saving' : store.dirty ? 'Modified' : 'Saved'}</span>
      </footer>
    </section>
  )
}
