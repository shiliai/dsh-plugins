import { useEffect, useState } from 'react'
import Check from 'lucide-react/dist/esm/icons/check'
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
  const [action, setAction] = useState<'move' | 'delete' | null>(null)
  const [renamePath, setRenamePath] = useState('')

  const note = state.active
  const trimmedRenamePath = renamePath.trim()
  const normalizedRenamePath = trimmedRenamePath === ''
    ? ''
    : trimmedRenamePath.endsWith('.md') ? trimmedRenamePath : `${trimmedRenamePath}.md`
  const canRename = note !== null && normalizedRenamePath !== '' && normalizedRenamePath !== note.path
  const pendingDiscard = state.pendingDiscard

  useEffect(() => {
    const interval = window.setInterval(() => { void store.pollActive() }, 3000)
    return () => { window.clearInterval(interval) }
  }, [store])

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
            <button className={state.mode === 'edit' ? css.selected : ''} type="button" title="Edit" aria-label="Edit" disabled={pendingDiscard !== null} onClick={() => { store.setMode('edit') }}><FilePenLine size={15} /></button>
            <button className={state.mode === 'preview' ? css.selected : ''} type="button" title="Preview" aria-label="Preview" disabled={pendingDiscard !== null} onClick={() => { store.setMode('preview') }}><Eye size={15} /></button>
          </div>
          <button
            className={css.iconButton}
            type="button"
            title="Add note to chat"
            aria-label="Add note to chat"
            disabled={note === null || inputActions === undefined || pendingDiscard !== null}
            onClick={() => {
              if (note !== null && inputActions !== undefined) {
                inputActions.setDraft(`${chatDraft}${chatDraft === '' ? '' : '\n\n'}Please work with the Obsidian note [[${note.path}]].`)
              }
            }}
          ><MessageSquarePlus size={16} /></button>
          <button className={css.iconButton} type="button" title="Save" aria-label="Save" disabled={!store.dirty || state.saving || pendingDiscard !== null} onClick={() => { void store.save() }}><Save size={16} /></button>
          <div className={css.menuAnchor}>
            <button
              className={css.iconButton}
              type="button"
              title="Note actions"
              aria-label="Note actions"
              aria-expanded={menuOpen}
              aria-controls="note-actions-menu"
              disabled={note === null || action !== null || pendingDiscard !== null}
              onClick={() => { setMenuOpen(value => !value) }}
            ><MoreHorizontal size={16} /></button>
            {menuOpen && note !== null && (
              <div id="note-actions-menu" className={css.actionMenu} role="menu">
                <button type="button" role="menuitem" onClick={() => {
                  setMenuOpen(false)
                  setRenamePath(note.path)
                  setAction('move')
                }}><RefreshCw size={14} />Move or rename</button>
                <button className={css.danger} type="button" role="menuitem" onClick={() => { setMenuOpen(false); setAction('delete') }}><Trash2 size={14} />Delete</button>
              </div>
            )}
          </div>
          <button className={css.iconButton} type="button" title="Close note" aria-label="Close note" disabled={pendingDiscard !== null} onClick={() => { store.closeNote() }}><X size={17} /></button>
        </div>
      </header>

      {pendingDiscard === null && action === 'move' && note !== null && (
        <form className={css.noteAction} aria-label="Move or rename note" onSubmit={event => {
          event.preventDefault()
          if (!canRename) return
          setAction(null)
          void store.renameActive(normalizedRenamePath)
        }}>
          <span className={css.noteActionTitle}>Move or rename</span>
          <label className={css.srOnly} htmlFor="note-rename-path">New note path</label>
          <input
            id="note-rename-path"
            className={css.renameInput}
            autoFocus
            value={renamePath}
            onChange={event => { setRenamePath(event.target.value) }}
          />
          <div className={css.actionControls}>
            <button className={css.iconButton} type="button" title="Cancel move or rename" aria-label="Cancel move or rename" onClick={() => { setAction(null) }}><X size={15} /></button>
            <button className={css.actionCommand} type="submit" disabled={!canRename || state.saving}><Check size={14} />Move</button>
          </div>
        </form>
      )}
      {pendingDiscard === null && action === 'delete' && note !== null && (
        <section className={css.noteAction} aria-label="Delete note confirmation">
          <div className={css.noteActionMessage}>
            <strong>Delete note?</strong>
            <span title={note.path}>{note.path}</span>
          </div>
          <div className={css.actionControls}>
            <button className={css.iconButton} type="button" title="Cancel delete" aria-label="Cancel delete" onClick={() => { setAction(null) }}><X size={15} /></button>
            <button className={`${css.actionCommand} ${css.danger}`} type="button" onClick={() => { setAction(null); void store.deleteActive() }}><Trash2 size={14} />Delete</button>
          </div>
        </section>
      )}
      {pendingDiscard !== null && (
        <section
          className={css.noteAction}
          role="alertdialog"
          aria-labelledby="discard-changes-title"
          aria-describedby="discard-changes-description"
        >
          <div className={css.noteActionMessage}>
            <strong id="discard-changes-title">Discard unsaved changes?</strong>
            <span id="discard-changes-description">
              {pendingDiscard.kind === 'open' ? `Open ${pendingDiscard.path} instead.` : 'Close this note.'}
            </span>
          </div>
          <div className={css.actionControls}>
            <button className={css.iconButton} type="button" title="Cancel" aria-label="Cancel" autoFocus onClick={() => { store.cancelPendingDiscard() }}><X size={15} /></button>
            <button className={`${css.actionCommand} ${css.danger}`} type="button" onClick={() => { void store.discardPendingChanges() }}><Trash2 size={14} />Discard</button>
          </div>
        </section>
      )}
      {state.error !== null && <div className={css.panelError} role="alert">{state.error}</div>}
      {state.loadingNote || note === null
        ? <div className={css.panelLoading}>Opening...</div>
        : state.mode === 'edit'
          ? <textarea className={css.editor} value={state.draft} aria-label={`Edit ${note.path}`} spellCheck readOnly={pendingDiscard !== null} onChange={event => { store.setDraft(event.target.value) }} />
          : <article className={css.preview}><MarkdownPreview content={state.draft} notePath={note.path} openNote={path => { void store.openNote(path) }} /></article>}
      <footer className={css.statusBar}>
        <span>{note === null ? '' : `${state.draft.split(/\r?\n/u).length} lines`}</span>
        <span>{state.saving ? 'Saving' : store.dirty ? 'Modified' : 'Saved'}</span>
      </footer>
    </section>
  )
}
