import Trash2 from 'lucide-react/dist/esm/icons/trash-2'
import X from 'lucide-react/dist/esm/icons/x'
import type { VaultStore } from './store.ts'
import css from './styles.module.css?dsh-inline'

/**
 * The "Discard unsaved changes?" prompt, shared by the note panel and the
 * workbench. It must be rendered by every surface that can trigger a
 * `pendingDiscard`: the store refuses all note opens/closes while a prompt is
 * pending, so a surface that starts one without rendering the prompt would
 * deadlock note opening until the page is reloaded.
 */
export function DiscardPrompt({ store }: { store: VaultStore }) {
  const state = store.useSnapshot()
  const pendingDiscard = state.pendingDiscard
  if (pendingDiscard === null) return null
  return (
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
  )
}
