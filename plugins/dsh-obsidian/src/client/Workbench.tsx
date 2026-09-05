import { createPortal } from 'react-dom'
import { useEffect, useMemo, useRef, useState } from 'react'
import X from 'lucide-react/dist/esm/icons/x'
import Plus from 'lucide-react/dist/esm/icons/plus'
import Save from 'lucide-react/dist/esm/icons/save'
import Settings from 'lucide-react/dist/esm/icons/settings'
import { MarkdownPreview } from './MarkdownPreview.tsx'
import { VaultBrowser } from './VaultBrowser.tsx'
import { SkillBrowser } from './SkillBrowser.tsx'
import type { VaultStore } from './store.ts'
import type { VaultContextKind, VaultTreeNode } from '../contracts.ts'
import { calculateWorkbenchLayout, type WorkbenchRect } from './workbench-geometry.ts'
import { findConversationAnchor, type ConversationAnchor } from './workbench-anchor.ts'
import css from './styles.module.css?dsh-inline'

interface Props {
  store: VaultStore
  close(): void
  addContextToChat(kind: VaultContextKind, value: string): Promise<void>
}

const STORAGE_KEY = 'dsh-obsidian.workbench.widths'
type Widths = { tree: number; editor: number; preview: number; chat: number }

export function Workbench({ store, close, addContextToChat }: Props) {
  const state = store.useSnapshot()
  const [anchor, setAnchor] = useState<ConversationAnchor | null>(() => findConversationAnchor())
  const [widths, setWidths] = useState<Widths>(() => loadWidths())
  const [tabs, setTabs] = useState<string[]>([])
  const [skillsOpen, setSkillsOpen] = useState(false)
  const draftCache = useRef(new Map<string, string>())
  const originalMargin = useRef<{ element: HTMLElement; left: string; top: string } | null>(null)
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

  useEffect(() => {
    const path = state.active?.path
    if (path === undefined) return
    setTabs(current => current.includes(path) ? current : [...current, path])
    const cached = draftCache.current.get(path)
    if (cached !== undefined && cached !== state.draft) store.setDraft(cached)
  }, [state.active?.path])

  useEffect(() => {
    if (state.active !== null) draftCache.current.set(state.active.path, state.draft)
  }, [state.active?.path, state.draft])

  useEffect(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(widths)) }, [widths])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [close])

  useEffect(() => () => {
    const original = originalMargin.current
    if (original !== null && original.element.isConnected) {
      original.element.style.marginLeft = original.left
      original.element.style.marginTop = original.top
    }
  }, [])

  if (anchor === null) return createPortal(<div className={css.workbenchUnavailable} role="status">Waiting for the active conversation…</div>, document.body)

  const rootRect = anchor.root.getBoundingClientRect()
  const headerRect = anchor.header?.getBoundingClientRect()
  const rect: WorkbenchRect = { left: rootRect.left, top: headerRect?.bottom ?? rootRect.top, right: rootRect.right, bottom: rootRect.bottom }
  const layout = calculateWorkbenchLayout(rect, { ...widths, gap: 8 })
  const compact = window.innerWidth < 720
  if (originalMargin.current?.element !== anchor.viewArea) {
    originalMargin.current = { element: anchor.viewArea, left: anchor.viewArea.style.marginLeft, top: anchor.viewArea.style.marginTop }
  }
  anchor.viewArea.style.marginLeft = compact ? '0px' : `${layout.chatMarginLeft}px`
  anchor.viewArea.style.marginTop = '0px'

  const openTab = (path: string) => {
    if (state.active !== null) draftCache.current.set(state.active.path, state.draft)
    void store.openNote(path, { allowDirty: true })
  }
  const closeTab = (path: string) => {
    setTabs(current => current.filter(tab => tab !== path))
    draftCache.current.delete(path)
    if (state.active?.path === path) {
      const next = tabs.find(tab => tab !== path)
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
  const pane = (key: 'tree' | 'editor' | 'preview', title: string, content: React.ReactNode) => {
    const paneRect = layout[key]
    return <section className={css.workbenchPane} aria-label={title} style={{ display: compact && key !== 'editor' ? 'none' : undefined, left: compact ? rect.left : paneRect.left, top: paneRect.top, width: compact ? rect.right - rect.left : paneRect.right - paneRect.left, height: paneRect.bottom - paneRect.top }}>
      <header className={css.workbenchHeader}><span>{title}</span>{key === 'editor' && <button className={css.iconButton} type="button" title="Save" aria-label="Save" disabled={!store.dirty} onClick={() => { void store.save() }}><Save size={15} /></button>}</header>
      {content}
      <div className={css.workbenchResize} role="separator" aria-label={`Resize ${title.replace('Note editor', 'note pane')}`} onPointerDown={event => beginResize(key, event)} onPointerMove={moveResize} onPointerUp={finishResize} />
    </section>
  }
  const notePaths = useMemo(() => flattenNotePaths(state.tree), [state.tree])

  return createPortal(<div className={css.workbenchRoot} data-dsh-obsidian-workbench>
    {pane('tree', 'Vault', <div className={css.workbenchTree}><VaultBrowser store={store} closeBrowser={close} wide expandSidebar={() => undefined} addContextToChat={addContextToChat} /></div>)}
    {pane('editor', 'Note editor', <div className={css.workbenchEditor}>
      <div className={css.workbenchTabs} role="tablist">{tabs.map(path => <button key={path} className={`${css.workbenchTab} ${state.active?.path === path ? css.selected : ''}`} type="button" role="tab" aria-selected={state.active?.path === path} onClick={() => openTab(path)}><span>{path.split('/').at(-1)}</span><X size={12} onClick={event => { event.stopPropagation(); closeTab(path) }} /></button>)}<button className={css.iconButton} type="button" title="Open a note from the tree" aria-label="Open a note from the tree"><Plus size={15} /></button></div>
      {state.active === null || state.loadingNote ? <div className={css.panelLoading}>Open a note from the Vault pane.</div> : <textarea className={css.editor} aria-label={`Edit ${state.active.path}`} value={state.draft} onChange={event => store.setDraft(event.target.value)} />}
      <footer className={css.statusBar}><span>{state.active === null ? '' : `${state.draft.split(/\r?\n/u).length} lines`}</span><span>{store.dirty ? 'Modified' : 'Saved'}</span></footer>
    </div>)}
    {pane('preview', 'Preview', <article className={css.preview}>{state.active === null ? <div className={css.panelLoading}>Preview follows the selected note.</div> : <MarkdownPreview content={state.draft} notePath={state.active.path} notePaths={notePaths} openNote={openTab} />}</article>)}
    {!compact && <div className={css.workbenchChatResize} role="separator" aria-label="Resize chat pane" onPointerDown={event => beginResize('chat', event)} onPointerMove={moveResize} onPointerUp={finishResize} style={{ left: layout.chat.left - 5, top: rect.top, height: rect.bottom - rect.top }} />}
    <div className={css.workbenchChrome}><button className={css.iconButton} type="button" title="Settings and skills" aria-label="Settings and skills" onClick={() => setSkillsOpen(true)}><Settings size={15} /></button><button className={css.iconButton} type="button" title="Close workbench" aria-label="Close workbench" onClick={close}><X size={16} /></button></div>
    {skillsOpen && <div className={css.modalOverlay} role="dialog" aria-modal="true" aria-label="dsh-obsidian settings"><section className={css.skillSettingsShell}><SkillBrowser store={store} root={state.vaultRoot} closeBrowser={() => setSkillsOpen(false)} wide expandSidebar={() => undefined} /></section></div>}
  </div>, document.body)
}

function flattenNotePaths(nodes: VaultTreeNode[]): string[] { return nodes.flatMap(node => node.type === 'note' ? [node.path] : flattenNotePaths(node.children ?? [])) }
function loadWidths(): Widths {
  try { const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}'); return { tree: finite(value.tree, 240), editor: finite(value.editor, 360), preview: finite(value.preview, 360), chat: finite(value.chat, 360) } } catch { return { tree: 240, editor: 360, preview: 360, chat: 360 } }
}
function finite(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) ? value : fallback }
