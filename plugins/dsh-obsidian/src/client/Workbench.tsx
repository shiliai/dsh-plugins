import { createPortal } from 'react-dom'
import { useEffect, useMemo, useRef, useState } from 'react'
import X from 'lucide-react/dist/esm/icons/x'
import Plus from 'lucide-react/dist/esm/icons/plus'
import Save from 'lucide-react/dist/esm/icons/save'
import PanelLeftClose from 'lucide-react/dist/esm/icons/panel-left-close'
import { MarkdownPreview } from './MarkdownPreview.tsx'
import { DiscardPrompt } from './DiscardPrompt.tsx'
import { NoteQuickOpen } from './NoteQuickOpen.tsx'
import { VaultBrowser } from './VaultBrowser.tsx'
import { WorkbenchHeader } from './WorkbenchHeader.tsx'
import { WorkspaceChip } from './WorkspaceChip.tsx'
import { useWorkspaceStatus, type WorkspaceStatusSource } from './workspace-status.ts'
import type { VaultStore } from './store.ts'
import type { VaultContextKind, VaultTreeNode } from '../contracts.ts'
import type { VaultContextAddResult } from './index.tsx'
import { calculateWorkbenchLayout, type WorkbenchPaneKey, type WorkbenchRect, type WorkbenchVisibility } from './workbench-geometry.ts'
import { findConversationAnchor, type ConversationAnchor } from './workbench-anchor.ts'
import css from './styles.module.css?dsh-inline'

interface Props {
  store: VaultStore
  /** Close the workbench; `info` (present for every intentional exit) drives the footer exit toast + undo. */
  close(info?: WorkbenchExitInfo): void
  addContextToChat(kind: VaultContextKind, value: string): Promise<VaultContextAddResult>
  /** Host faces for the workspace chip; undefined degrades the chip to 'unknown'. */
  status?: WorkspaceStatusSource | undefined
  /** Land the conversation in the vault workspace (or open a new vault conversation). */
  openVaultConversation?: (() => Promise<void>) | undefined
  /** Visibility to start with (undo reopen); defaults to the persisted preference. */
  initialVisibility?: WorkbenchVisibility | undefined
}

/** Facts the footer needs to render the exit toast. */
export interface WorkbenchExitInfo {
  reason: 'manual' | 'auto'
  /** Visibility at exit time; undo reopens with it. */
  visibility: WorkbenchVisibility
  dirtyDrafts: boolean
}

const STORAGE_KEY = 'dsh-obsidian.workbench.widths'
const VISIBILITY_STORAGE_KEY = 'dsh-obsidian.workbench.visibility'
const RESTORE_BAR_DISMISSED_KEY = 'dsh-obsidian.workbench.restoreBarDismissed'
/** Height of the workbench header bar; the conversation area shifts down by it. */
const HEADER_HEIGHT = 36
type Widths = { tree: number; editor: number; preview: number; chat: number }
const CONTENT_PANES: WorkbenchPaneKey[] = ['tree', 'editor', 'preview']
const DEFAULT_VISIBILITY: WorkbenchVisibility = { tree: true, editor: true, preview: true, chat: true }

export function Workbench({ store, close, addContextToChat, status, openVaultConversation, initialVisibility }: Props) {
  const state = store.useSnapshot()
  const workspaceStatus = useWorkspaceStatus(status, state.vaultRoot)
  const [anchor, setAnchor] = useState<ConversationAnchor | null>(() => findConversationAnchor())
  const [widths, setWidths] = useState<Widths>(() => loadWidths())
  const [visibility, setVisibility] = useState<WorkbenchVisibility>(() => initialVisibility ?? loadVisibility())
  const [quickOpen, setQuickOpen] = useState(false)
  /** Path B: per-pane hide on the last visible content pane → confirm before exiting. */
  const [confirmHide, setConfirmHide] = useState<WorkbenchPaneKey | null>(null)
  const [restoreBarDismissed, setRestoreBarDismissed] = useState<boolean>(() => loadRestoreBarDismissed())
  const originalMargin = useRef<{ element: HTMLElement; left: string; top: string; visibility: string } | null>(null)
  const drag = useRef<{ key: keyof Widths; startX: number; start: number } | null>(null)

  useEffect(() => {
    store.setPanelSuppressed(true)
    void store.initialize()
    const observer = new MutationObserver(() => setAnchor(findConversationAnchor()))
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-phase'] })
    const refresh = () => setAnchor(findConversationAnchor())
    window.addEventListener('resize', refresh)
    return () => { observer.disconnect(); window.removeEventListener('resize', refresh); store.setPanelSuppressed(false) }
  }, [store])

  // Store-owned tabs: reopening the workbench restores them; opening a note
  // with a cached draft restores the draft (per-path, in the store).
  useEffect(() => {
    const path = state.active?.path
    if (path === undefined) return
    store.addTab(path)
  }, [store, state.active?.path])

  useEffect(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(widths)) }, [widths])
  useEffect(() => { localStorage.setItem(VISIBILITY_STORAGE_KEY, JSON.stringify(visibility)) }, [visibility])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // §6.5: only close when the workbench layer holds the interaction —
      // either inside the workbench DOM or inside the conversation area that
      // acts as its chat pane. Otherwise host shortcuts keep precedence.
      const target = event.target as HTMLElement | null
      const inWorkbench = target === null || target === document.body
        || target.closest('[data-dsh-obsidian-workbench]') !== null
        || (anchor?.viewArea !== undefined && anchor.viewArea.contains(target))
      if (!inWorkbench) return
      // The quick-open picker and discard prompt handle Escape themselves;
      // Escape must not tear down the workbench underneath them.
      if (quickOpen || state.pendingDiscard !== null) return
      close({ reason: 'manual', visibility, dirtyDrafts: store.hasDirtyDrafts })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [anchor?.viewArea, close, quickOpen, state.pendingDiscard, store, visibility])

  // A pending discard belongs to this surface's prompts; closing the
  // workbench without resolving it would leave the store refusing every
  // later note open, so cancel (never discard) on the way out.
  useEffect(() => () => { store.cancelPendingDiscard() }, [store])

  useEffect(() => () => {
    const original = originalMargin.current
    if (original !== null && original.element.isConnected) {
      original.element.style.marginLeft = original.left
      original.element.style.marginTop = original.top
      original.element.style.visibility = original.visibility
    }
  }, [])

  const notePaths = useMemo(() => flattenNotePaths(state.tree), [state.tree])

  if (anchor === null) return createPortal(<div className={css.workbenchUnavailable} role="status">Waiting for the active conversation…</div>, document.body)

  const rootRect = anchor.root.getBoundingClientRect()
  const headerRect = anchor.header?.getBoundingClientRect()
  const rect: WorkbenchRect = { left: rootRect.left, top: headerRect?.bottom ?? rootRect.top, right: rootRect.right, bottom: rootRect.bottom }
  // The workbench header bar occupies the top strip; panes and the chat area
  // start below it (the conversation area gains a matching margin-top).
  const contentRect: WorkbenchRect = { ...rect, top: rect.top + HEADER_HEIGHT }
  const layout = calculateWorkbenchLayout(contentRect, { ...widths, gap: 8 }, visibility)
  const compact = window.innerWidth < 720
  const contentPanesVisible = CONTENT_PANES.some(key => visibility[key])
  if (originalMargin.current?.element !== anchor.viewArea) {
    const previous = originalMargin.current
    if (previous !== null && previous.element.isConnected) {
      previous.element.style.marginLeft = previous.left
      previous.element.style.marginTop = previous.top
      previous.element.style.visibility = previous.visibility
    }
    originalMargin.current = { element: anchor.viewArea, left: anchor.viewArea.style.marginLeft, top: anchor.viewArea.style.marginTop, visibility: anchor.viewArea.style.visibility }
  }
  anchor.viewArea.style.marginLeft = compact ? '0px' : `${layout.chatMarginLeft}px`
  anchor.viewArea.style.marginTop = `${HEADER_HEIGHT}px`
  anchor.viewArea.style.visibility = visibility.chat ? originalMargin.current?.visibility ?? '' : 'hidden'

  const openTab = (path: string) => {
    store.addTab(path)
    void store.openNote(path, { allowDirty: true })
  }
  const closeTab = (path: string) => {
    const remaining = store.removeTab(path)
    if (state.active?.path === path) {
      const next = remaining[0]
      if (next === undefined) store.closeNote()
      else void store.openNote(next, { allowDirty: true })
    }
  }
  const beginResize = (key: keyof Widths, event: React.PointerEvent) => {
    drag.current = { key, startX: event.clientX, start: widths[key] }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const moveResize = (event: React.PointerEvent) => {
    const current = drag.current
    if (current === null) return
    const minimum = current.key === 'tree' ? 180 : current.key === 'chat' ? 280 : 240
    setWidths(value => ({ ...value, [current.key]: Math.max(minimum, current.start + event.clientX - current.startX) }))
  }
  const finishResize = () => { drag.current = null }

  /** Path A: segmented toggle of a content pane — hiding the last one is a legal pure-chat layout. */
  const togglePane = (key: WorkbenchPaneKey, visible: boolean) => {
    if (key === 'chat' && !visible && !contentPanesVisible) {
      // Path C: nothing visible would remain — auto-exit instead of an empty layer.
      close({ reason: 'auto', visibility, dirtyDrafts: store.hasDirtyDrafts })
      return
    }
    setVisibility(current => ({ ...current, [key]: visible }))
  }
  /** Path B: a pane ✕ on the last visible content pane asks before exiting. */
  const hidePane = (key: WorkbenchPaneKey) => {
    const remaining = CONTENT_PANES.filter(pane => pane !== key && visibility[pane])
    if (remaining.length === 0) { setConfirmHide(key); return }
    setVisibility(current => ({ ...current, [key]: false }))
  }
  const confirmHideExit = () => {
    setConfirmHide(null)
    close({ reason: 'auto', visibility, dirtyDrafts: store.hasDirtyDrafts })
  }
  const dismissRestoreBar = () => {
    setRestoreBarDismissed(true)
    try { localStorage.setItem(RESTORE_BAR_DISMISSED_KEY, 'true') } catch { /* storage is optional */ }
  }
  const openVaultChooser = () => {
    // The chooser renders inside the Vault pane; reveal it first if hidden.
    if (!visibility.tree) setVisibility(current => ({ ...current, tree: true }))
    void store.openVaultChooser()
  }
  const mobilePane = (['editor', 'tree', 'preview'] as const).find(key => visibility[key])
  const pane = (key: 'tree' | 'editor' | 'preview', title: string, content: React.ReactNode) => {
    if (!visibility[key] || (compact && mobilePane !== key)) return null
    const paneRect = layout[key]
    return <section className={css.workbenchPane} aria-label={title} style={{ left: compact ? rect.left : paneRect.left, top: paneRect.top, width: compact ? rect.right - rect.left : paneRect.right - paneRect.left, height: paneRect.bottom - paneRect.top }}>
      <header className={css.workbenchHeader}><span>{title}</span><div className={css.workbenchHeaderActions}>{key === 'editor' && <button className={css.iconButton} type="button" title="Save" aria-label="Save" disabled={!store.dirty} onClick={() => { void store.save() }}><Save size={15} /></button>}<button className={css.iconButton} type="button" title={`Hide ${title} pane`} aria-label={`Hide ${title} pane`} onClick={() => hidePane(key)}><PanelLeftClose size={14} /></button></div></header>
      {content}
      <div className={css.workbenchResize} role="separator" aria-label={`Resize ${title.replace('Note editor', 'note pane')}`} onPointerDown={event => beginResize(key, event)} onPointerMove={moveResize} onPointerUp={finishResize} />
    </section>
  }

  return createPortal(<div className={css.workbenchRoot} data-dsh-obsidian-workbench>
    <div style={{ position: 'fixed', left: rect.left, top: rect.top, width: rect.right - rect.left, height: HEADER_HEIGHT, pointerEvents: 'none' }}>
      <WorkbenchHeader
        vaultName={state.vaultName}
        vaultRoot={state.vaultRoot}
        visibility={visibility}
        onTogglePane={togglePane}
        onVaultChooser={openVaultChooser}
        onExit={() => close({ reason: 'manual', visibility, dirtyDrafts: store.hasDirtyDrafts })}
        chip={openVaultConversation === undefined
          ? undefined
          : <WorkspaceChip status={workspaceStatus} vaultName={state.vaultName} vaultRoot={state.vaultRoot} openVaultConversation={openVaultConversation} />}
      />
    </div>
    {pane('tree', 'Vault', <div className={css.workbenchTree}><VaultBrowser store={store} closeBrowser={() => close({ reason: 'manual', visibility, dirtyDrafts: store.hasDirtyDrafts })} wide expandSidebar={() => undefined} addContextToChat={addContextToChat} openNote={openTab} /></div>)}
    {pane('editor', 'Note editor', <div className={css.workbenchEditor}>
      <div className={css.workbenchTabs} role="tablist">{state.openTabs.map(path => <button key={path} className={`${css.workbenchTab} ${state.active?.path === path ? css.selected : ''}`} type="button" role="tab" aria-selected={state.active?.path === path} onClick={() => openTab(path)}><span>{path.split('/').at(-1)}</span><X size={12} onClick={event => { event.stopPropagation(); closeTab(path) }} /></button>)}<button className={css.iconButton} type="button" title="Open a note (search the vault)" aria-label="Open a note from the vault" onClick={() => { setQuickOpen(true) }}><Plus size={15} /></button></div>
      {state.active === null || state.loadingNote ? <div className={css.panelLoading}>Open a note from the Vault pane.</div> : <textarea className={css.editor} aria-label={`Edit ${state.active.path}`} value={state.draft} onChange={event => store.setDraft(event.target.value)} />}
      <footer className={css.statusBar}><span>{state.active === null ? '' : `${state.draft.split(/\r?\n/u).length} lines`}</span><span>{store.dirty ? 'Modified' : 'Saved'}</span></footer>
    </div>)}
    {pane('preview', 'Preview', <article className={css.preview}>{state.active === null ? <div className={css.panelLoading}>Preview follows the selected note.</div> : <MarkdownPreview content={state.draft} notePath={state.active.path} notePaths={notePaths} openNote={openTab} />}</article>)}
    {/* Path A: a pure-chat layout is legal — offer a dismissible restore hint, never a modal. */}
    {!contentPanesVisible && visibility.chat && !restoreBarDismissed && (
      <div className={css.workbenchRestoreBar} role="status" style={{ left: (rect.left + rect.right) / 2, top: rect.top + HEADER_HEIGHT + 8 }}>
        <span>已隐藏全部笔记面板</span>
        <button className={css.actionCommand} type="button" onClick={() => setVisibility(DEFAULT_VISIBILITY)}>恢复笔记面板</button>
        <button className={css.iconButton} type="button" title="不再提示" aria-label="不再提示" onClick={dismissRestoreBar}><X size={12} /></button>
      </div>
    )}
    {/* Path B: confirm before the last pane ✕ exits the mode. */}
    {confirmHide !== null && (() => {
      const paneRect = layout[confirmHide]
      return <div className={css.workbenchConfirm} role="alertdialog" aria-label="退出 Obsidian 模式?" style={{ left: paneRect.left + 10, top: paneRect.top + 6 }}>
        <span>收起全部笔记面板并退出 Obsidian?</span>
        <div className={css.workbenchConfirmActions}>
          <button className={css.actionCommand} type="button" onClick={confirmHideExit}>退出</button>
          <button className={css.actionCommand} type="button" onClick={() => setConfirmHide(null)}>取消</button>
        </div>
      </div>
    })()}
    {quickOpen && <div className={css.modalOverlay} onPointerDown={event => { if (event.target === event.currentTarget) setQuickOpen(false) }}><NoteQuickOpen openNote={openTab} close={() => { setQuickOpen(false) }} /></div>}
    {state.pendingDiscard !== null && <div className={css.modalOverlay}><div className={css.workbenchDiscard}><DiscardPrompt store={store} /></div></div>}
    {!compact && visibility.chat && <div className={css.workbenchChatResize} role="separator" aria-label="Resize chat pane" onPointerDown={event => beginResize('chat', event)} onPointerMove={moveResize} onPointerUp={finishResize} style={{ left: layout.chat.left - 5, top: contentRect.top, height: rect.bottom - contentRect.top }} />}
  </div>, document.body)
}

function flattenNotePaths(nodes: VaultTreeNode[]): string[] { return nodes.flatMap(node => node.type === 'note' ? [node.path] : flattenNotePaths(node.children ?? [])) }
function loadWidths(): Widths {
  try { const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}'); return { tree: finite(value.tree, 240), editor: finite(value.editor, 360), preview: finite(value.preview, 360), chat: finite(value.chat, 360) } } catch { return { tree: 240, editor: 360, preview: 360, chat: 360 } }
}
function finite(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) ? value : fallback }

function loadVisibility(): WorkbenchVisibility {
  try {
    const value = JSON.parse(localStorage.getItem(VISIBILITY_STORAGE_KEY) ?? '{}') as Partial<WorkbenchVisibility>
    const visibility: WorkbenchVisibility = { tree: value.tree !== false, editor: value.editor !== false, preview: value.preview !== false, chat: value.chat !== false }
    // Lockout guard: a persisted no-visible-pane state has no owner left to
    // restore it from inside the layer, so treat it as corrupt.
    if (!visibility.tree && !visibility.editor && !visibility.preview && !visibility.chat) return DEFAULT_VISIBILITY
    return visibility
  } catch { return DEFAULT_VISIBILITY }
}

function loadRestoreBarDismissed(): boolean {
  try { return localStorage.getItem(RESTORE_BAR_DISMISSED_KEY) === 'true' } catch { return false }
}
