import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import ArrowLeft from 'lucide-react/dist/esm/icons/arrow-left'
import ArrowUp from 'lucide-react/dist/esm/icons/arrow-up'
import Check from 'lucide-react/dist/esm/icons/check'
import ChevronsDownUp from 'lucide-react/dist/esm/icons/chevrons-down-up'
import ChevronDown from 'lucide-react/dist/esm/icons/chevron-down'
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right'
import FilePlus2 from 'lucide-react/dist/esm/icons/file-plus-2'
import FileText from 'lucide-react/dist/esm/icons/file-text'
import Folder from 'lucide-react/dist/esm/icons/folder'
import FolderOpen from 'lucide-react/dist/esm/icons/folder-open'
import FolderCog from 'lucide-react/dist/esm/icons/folder-cog'
import LoaderCircle from 'lucide-react/dist/esm/icons/loader-circle'
import MessageSquarePlus from 'lucide-react/dist/esm/icons/message-square-plus'
import Search from 'lucide-react/dist/esm/icons/search'
import Tag from 'lucide-react/dist/esm/icons/tag'
import X from 'lucide-react/dist/esm/icons/x'
import type { VaultContextKind, VaultTreeNode } from '../contracts.ts'
import type { VaultStore } from './store.ts'
import css from './styles.module.css?dsh-inline'

interface Props {
  store: VaultStore
  closeBrowser(): void
  wide: boolean
  expandSidebar(): void
  addContextToChat(kind: VaultContextKind, value: string): Promise<void>
}

interface ContextTarget {
  kind: VaultContextKind
  value: string
  label: string
}

interface ContextMenuState extends ContextTarget {
  x: number
  y: number
}

interface TreePreferences {
  defaultExpanded: boolean
  expandedPaths: Record<string, boolean>
}

const TREE_PREFERENCES_KEY = 'dsh-obsidian.vault.tree-preferences'

export function VaultBrowser({ store, closeBrowser, wide, expandSidebar, addContextToChat }: Props) {
  const state = store.useSnapshot()
  const directoryListing = state.directoryListing
  // In-place note creation: parentDir '' means the vault root.
  const [creation, setCreation] = useState<{ parentDir: string } | null>(null)
  // Path of a just-created note: scrolled into view with a flash highlight.
  const [flashPath, setFlashPath] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string; path?: string } | null>(null)
  const [treePreferences, setTreePreferences] = useState<TreePreferences>(() => loadTreePreferences())
  const treeRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    void store.initialize()
    let tagRefreshTicks = 0
    const interval = window.setInterval(() => {
      void store.refreshTree()
      if (store.getSnapshot().view === 'tags') {
        tagRefreshTicks++
        if (tagRefreshTicks >= 6) {
          tagRefreshTicks = 0
          void store.refreshTags()
        }
      } else {
        tagRefreshTicks = 0
      }
    }, 5000)
    return () => { window.clearInterval(interval) }
  }, [store])

  useEffect(() => {
    if (contextMenu === null) return
    const close = (): void => { setContextMenu(null) }
    const closeOnEscape = (event: KeyboardEvent): void => { if (event.key === 'Escape') close() }
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [contextMenu])

  useEffect(() => {
    try { localStorage.setItem(TREE_PREFERENCES_KEY, JSON.stringify(treePreferences)) } catch { /* storage is optional */ }
  }, [treePreferences])

  // Keep the creation target folder visible while the inline row is open.
  useEffect(() => {
    if (creation === null) return
    treeRef.current?.querySelector('[data-create-target]')?.scrollIntoView({ block: 'nearest' })
  }, [creation])

  // After a successful create, reveal the new note row (flash highlight).
  useEffect(() => {
    if (flashPath === null) return
    treeRef.current?.querySelector(`[data-note-path="${CSS.escape(flashPath)}"]`)?.scrollIntoView({ block: 'nearest' })
    const timer = window.setTimeout(() => { setFlashPath(current => current === flashPath ? null : current) }, 1300)
    return () => { window.clearTimeout(timer) }
  }, [flashPath])

  const filteredTags = useMemo(() => {
    const query = state.query.trim().toLocaleLowerCase().replace(/^#/u, '')
    return query === '' ? state.tags : state.tags.filter(tag => tag.name.toLocaleLowerCase().includes(query))
  }, [state.query, state.tags])

  const openContextMenu = (event: ReactMouseEvent, target: ContextTarget): void => {
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({
      ...target,
      x: Math.min(event.clientX, window.innerWidth - 184),
      y: Math.min(event.clientY, window.innerHeight - 48),
    })
  }

  const addContext = async (target: ContextTarget): Promise<void> => {
    setContextMenu(null)
    setFeedback(null)
    try {
      await addContextToChat(target.kind, target.value)
      setFeedback({ kind: 'success', text: `Added ${target.label} to chat.` })
    } catch (error) {
      setFeedback({ kind: 'error', text: error instanceof Error ? error.message : 'Could not add Vault context to chat.' })
    }
  }
  const startCreation = (parentDir: string): void => {
    setContextMenu(null)
    setFeedback(null)
    // Creation happens inside the notes tree; leave tags/search views first.
    if (state.view !== 'notes') store.setView('notes')
    if (state.query.trim() !== '') void store.search('')
    if (parentDir !== '') {
      // Expand the target folder and all its ancestors.
      const segments = parentDir.split('/')
      setTreePreferences(value => {
        const expandedPaths = { ...value.expandedPaths }
        segments.forEach((_, index) => { expandedPaths[segments.slice(0, index + 1).join('/')] = true })
        return { ...value, expandedPaths }
      })
    }
    setCreation({ parentDir })
  }
  const createInFolder = (target: ContextTarget): void => {
    startCreation(target.value)
  }
  const handleCreated = (path: string): void => {
    setCreation(null)
    setFlashPath(path)
    setFeedback({ kind: 'success', text: `Created ${path}`, path })
  }

  if (!wide) {
    return (
      <button className={css.railButton} type="button" title="Open vault" aria-label="Open vault" onClick={expandSidebar}>
        <FolderOpen size={18} />
      </button>
    )
  }

  const searchTarget: ContextTarget = { kind: 'search', value: state.query, label: `search “${state.query}”` }
  const tagTarget = state.selectedTag === null ? null : { kind: 'tag' as const, value: state.selectedTag, label: `#${state.selectedTag}` }

  return (
    <section className={css.browser} aria-label="Obsidian vault">
      <header className={css.browserHeader}>
        <button className={css.iconButton} type="button" title="Back to sessions" aria-label="Back to sessions" onClick={closeBrowser}>
          <ArrowLeft size={16} />
        </button>
        <strong title={state.vaultRoot}>{state.vaultName}</strong>
        <button
          className={css.iconButton}
          type="button"
          title={store.dirty ? 'Save or discard changes before switching vaults' : 'Select vault directory'}
          aria-label="Select vault directory"
          disabled={store.dirty}
          onClick={() => { void store.openVaultChooser() }}
        >
          <FolderCog size={16} />
        </button>
        <button
          className={css.iconButton}
          type="button"
          title={treePreferences.defaultExpanded ? 'Folders start expanded' : 'Folders start collapsed'}
          aria-label={treePreferences.defaultExpanded ? 'Folders start expanded' : 'Folders start collapsed'}
          aria-pressed={treePreferences.defaultExpanded}
          onClick={() => { setTreePreferences(value => ({ ...value, defaultExpanded: !value.defaultExpanded })) }}
        >
          <ChevronsDownUp size={16} />
        </button>
        <button className={css.iconButton} type="button" title="New note" aria-label="New note" onClick={() => { startCreation('') }}>
          <FilePlus2 size={16} />
        </button>
      </header>

      {directoryListing !== null && (
        <section className={css.directoryChooser} aria-label="Select vault directory">
          <div className={css.directoryToolbar}>
            <button
              className={css.iconButton}
              type="button"
              title="Parent directory"
              aria-label="Parent directory"
              disabled={directoryListing.parent === null || state.loadingDirectories || state.switchingVault}
              onClick={() => { if (directoryListing.parent !== null) void store.browseDirectories(directoryListing.parent) }}
            ><ArrowUp size={16} /></button>
            <span title={directoryListing.path}>{directoryListing.path}</span>
            <button className={css.iconButton} type="button" title="Cancel" aria-label="Cancel vault selection" disabled={state.switchingVault} onClick={() => { store.closeVaultChooser() }}><X size={16} /></button>
          </div>
          <div className={css.directoryList}>
            {directoryListing.directories.map(directory => (
              <button key={directory.path} className={css.directoryRow} type="button" disabled={state.loadingDirectories || state.switchingVault} onClick={() => { void store.browseDirectories(directory.path) }}>
                <Folder size={15} /><span>{directory.name}</span><ChevronRight size={14} />
              </button>
            ))}
            {!state.loadingDirectories && directoryListing.directories.length === 0 && <div className={css.emptyDirectory}>No subdirectories</div>}
          </div>
          <button className={css.selectDirectory} type="button" disabled={state.loadingDirectories || state.switchingVault} onClick={() => { void store.selectVault(directoryListing.path) }}>
            {state.switchingVault ? <LoaderCircle className={css.spin} size={15} /> : <Check size={15} />}
            Use this folder
          </button>
        </section>
      )}

      {directoryListing !== null ? null : <>
        <div className={css.browserTabs} role="tablist" aria-label="Vault view">
          <button role="tab" aria-selected={state.view === 'notes'} className={state.view === 'notes' ? css.selected : ''} type="button" onClick={() => { store.setView('notes') }}><FileText size={14} />Notes</button>
          <button role="tab" aria-selected={state.view === 'tags'} className={state.view === 'tags' ? css.selected : ''} type="button" onClick={() => { store.setView('tags') }}><Tag size={14} />Tags</button>
        </div>

        {state.view === 'tags' && state.selectedTag !== null ? (
          <div className={css.tagScopeBar}>
            <button className={css.iconButton} type="button" title="Back to tags" aria-label="Back to tags" onClick={() => { store.clearSelectedTag() }}><ArrowLeft size={15} /></button>
            <span title={`#${state.selectedTag}`}><Tag size={14} />#{state.selectedTag}</span>
            <button className={css.iconButton} type="button" title="Add tag results to chat" aria-label={`Add #${state.selectedTag} to chat`} onClick={() => { if (tagTarget !== null) void addContext(tagTarget) }}><MessageSquarePlus size={15} /></button>
          </div>
        ) : (
          <div className={css.searchBox}>
            <Search size={15} />
            <input
              value={state.query}
              placeholder={state.view === 'notes' ? 'Search notes' : 'Filter tags'}
              aria-label={state.view === 'notes' ? 'Search notes' : 'Filter tags'}
              onChange={event => { state.view === 'notes' ? void store.search(event.target.value) : store.setTagQuery(event.target.value) }}
            />
            {(state.loadingTree || state.loadingTags) && <LoaderCircle className={css.spin} size={14} />}
            {state.view === 'notes' && state.query.trim() !== '' && state.searchResults.length > 0 && (
              <button className={css.contextAddButton} type="button" title="Add search results to chat" aria-label="Add search results to chat" onClick={() => { void addContext(searchTarget) }}><MessageSquarePlus size={15} /></button>
            )}
          </div>
        )}

        {feedback !== null && <div className={feedback.kind === 'success' ? css.inlineSuccess : css.inlineError} role={feedback.kind === 'success' ? 'status' : 'alert'}>{feedback.kind === 'success' && feedback.path !== undefined ? <button className={css.noteLink} type="button" onClick={() => { if (feedback.path !== undefined) void store.openNote(feedback.path) }}>{feedback.text}</button> : feedback.text}</div>}
        {state.error !== null && <div className={css.inlineError} role="alert">{state.error}</div>}

        <div
          ref={treeRef}
          className={css.tree}
          role={state.view === 'notes' && state.query.trim() === '' ? 'tree' : undefined}
          aria-label={state.view === 'notes' ? 'Notes' : 'Tags'}
          onContextMenu={event => {
            if (state.view === 'notes' && state.query.trim() !== '' && state.searchResults.length > 0) openContextMenu(event, searchTarget)
            else if (tagTarget !== null && state.tagPaths.length > 0) openContextMenu(event, tagTarget)
          }}
        >
          {state.view === 'notes' && state.query.trim() === '' && creation !== null && creation.parentDir === '' && (
            <NewNoteRow
              store={store}
              parentDir=""
              siblings={rootNoteNames(state.tree)}
              onCancel={() => { setCreation(null) }}
              onCreated={handleCreated}
            />
          )}
          {state.view === 'notes' && state.query.trim() === '' && state.tree.map(node => (
            <TreeNode
              key={node.path}
              node={node}
              activePath={state.active?.path}
              defaultExpanded={treePreferences.defaultExpanded}
              expandedPaths={treePreferences.expandedPaths}
              open={path => { void store.openNote(path) }}
              openMenu={openContextMenu}
              add={target => { void addContext(target) }}
              setExpanded={(path, expanded) => { setTreePreferences(value => ({ ...value, expandedPaths: { ...value.expandedPaths, [path]: expanded } })) }}
              create={createInFolder}
              store={store}
              creation={creation}
              flashPath={flashPath}
              onCancelCreation={() => { setCreation(null) }}
              onCreated={handleCreated}
            />
          ))}

          {state.view === 'notes' && state.query.trim() !== '' && state.searchResults.map(result => {
            const target = { kind: 'note' as const, value: result.path, label: result.path }
            return (
              <ContextRow key={`${result.path}:${result.line}`} target={target} openMenu={openContextMenu} add={addContext}>
                <button className={css.searchResult} type="button" onClick={() => { void store.openNote(result.path) }}>
                  <span><FileText size={14} />{result.path}</span>
                  <small>{result.line > 0 ? `L${result.line} ` : ''}{result.excerpt}</small>
                </button>
              </ContextRow>
            )
          })}

          {state.view === 'tags' && state.selectedTag === null && filteredTags.map(tag => {
            const target = { kind: 'tag' as const, value: tag.name, label: `#${tag.name}` }
            return (
              <ContextRow key={tag.name} target={target} openMenu={openContextMenu} add={addContext}>
                <button className={css.tagRow} type="button" onClick={() => { void store.selectTag(tag.name) }}>
                  <Tag size={14} /><span>#{tag.name}</span><small>{tag.count}</small><ChevronRight size={14} />
                </button>
              </ContextRow>
            )
          })}

          {state.view === 'tags' && state.selectedTag !== null && state.tagPaths.map(path => {
            const target = { kind: 'note' as const, value: path, label: path }
            return (
              <ContextRow key={path} target={target} openMenu={openContextMenu} add={addContext}>
                <button className={css.treeRow} type="button" onClick={() => { void store.openNote(path) }}><FileText size={14} /><span>{path}</span></button>
              </ContextRow>
            )
          })}

          {!state.loadingTags && state.view === 'tags' && state.selectedTag === null && filteredTags.length === 0 && <div className={css.emptyDirectory}>No tags found</div>}
          {!state.loadingTags && state.view === 'tags' && state.selectedTag !== null && state.tagPaths.length === 0 && <div className={css.emptyDirectory}>No matching notes</div>}
        </div>
      </>}

      {contextMenu !== null && (
        <div className={css.contextMenu} role="menu" style={{ left: contextMenu.x, top: contextMenu.y }} onPointerDown={event => { event.stopPropagation() }}>
          {contextMenu.kind === 'directory' && <button type="button" role="menuitem" onClick={() => { createInFolder(contextMenu) }}><FilePlus2 size={14} />New note here</button>}
          <button type="button" role="menuitem" onClick={() => { void addContext(contextMenu) }}><MessageSquarePlus size={14} />Add to chat</button>
        </div>
      )}
    </section>
  )
}

function ContextRow({ target, openMenu, add, children }: {
  target: ContextTarget
  openMenu(event: ReactMouseEvent, target: ContextTarget): void
  add(target: ContextTarget): Promise<void> | void
  children: ReactNode
}) {
  return (
    <div className={css.contextRow} onContextMenu={event => { openMenu(event, target) }}>
      {children}
      <button className={css.contextAddButton} type="button" title="Add to chat" aria-label={`Add ${target.label} to chat`} onClick={() => { void add(target) }}><MessageSquarePlus size={14} /></button>
    </div>
  )
}

function TreeNode({ node, activePath, defaultExpanded, expandedPaths, open, openMenu, add, setExpanded, create, store, creation, flashPath, onCancelCreation, onCreated }: {
  node: VaultTreeNode
  activePath: string | undefined
  defaultExpanded: boolean
  expandedPaths: Record<string, boolean>
  open(path: string): void
  openMenu(event: ReactMouseEvent, target: ContextTarget): void
  add(target: ContextTarget): void
  setExpanded(path: string, expanded: boolean): void
  create(target: ContextTarget): void
  store: VaultStore
  creation: { parentDir: string } | null
  flashPath: string | null
  onCancelCreation(): void
  onCreated(path: string): void
}) {
  const childCount = useMemo(() => node.children?.length ?? 0, [node.children])
  const expanded = expandedPaths[node.path] ?? defaultExpanded
  const target = { kind: node.type === 'note' ? 'note' as const : 'directory' as const, value: node.path, label: node.path }
  if (node.type === 'note') {
    return (
      <div role="treeitem" aria-selected={activePath === node.path} data-note-path={node.path} className={flashPath === node.path ? css.flashCreated : undefined}>
        <ContextRow target={target} openMenu={openMenu} add={add}>
          <button className={`${css.treeRow} ${activePath === node.path ? css.active : ''}`} type="button" onClick={() => { open(node.path) }}>
            <FileText size={14} /><span>{node.name.replace(/\.md$/iu, '')}</span>
          </button>
        </ContextRow>
      </div>
    )
  }
  const isCreateTarget = creation !== null && creation.parentDir === node.path
  return (
    <div role="treeitem" aria-expanded={expanded} {...(isCreateTarget ? { 'data-create-target': node.path } : {})}>
      <ContextRow target={target} openMenu={openMenu} add={add}>
        <button className={`${css.treeRow} ${isCreateTarget ? css.createTarget : ''}`} type="button" onClick={() => { setExpanded(node.path, !expanded) }}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
          <span>{node.name}</span><small>{childCount}</small>
        </button>
      </ContextRow>
      {expanded && (
        <div className={css.treeChildren} role="group">
          {isCreateTarget && (
            <NewNoteRow
              store={store}
              parentDir={node.path}
              siblings={noteSiblingNames(node)}
              onCancel={onCancelCreation}
              onCreated={onCreated}
            />
          )}
          {node.children?.map(child => <TreeNode key={child.path} node={child} activePath={activePath} defaultExpanded={defaultExpanded} expandedPaths={expandedPaths} open={open} openMenu={openMenu} add={add} setExpanded={setExpanded} create={create} store={store} creation={creation} flashPath={flashPath} onCancelCreation={onCancelCreation} onCreated={onCreated} />)}
        </div>
      )}
    </div>
  )
}

/** Names of existing note children of a folder node (folders excluded). */
function noteSiblingNames(node: VaultTreeNode): string[] {
  return (node.children ?? []).filter(child => child.type === 'note').map(child => child.name)
}

/** Names of existing notes at the vault root (folders excluded). */
function rootNoteNames(nodes: VaultTreeNode[]): string[] {
  return nodes.filter(node => node.type === 'note').map(node => node.name)
}

/** Returns an error message, or null when the name is empty (just disabled) or valid. */
function validateNoteName(name: string, siblings: string[]): string | null {
  const trimmed = name.trim()
  if (trimmed === '') return null
  if (/[\\:*?"<>|]/u.test(trimmed)) return 'Name contains illegal characters: \\ : * ? " < > |'
  const segments = trimmed.split('/')
  const file = `${(segments.at(-1) ?? trimmed).replace(/\.md$/iu, '')}.md`
  if (segments.length === 1 && siblings.some(sibling => sibling.toLocaleLowerCase() === file.toLocaleLowerCase())) {
    return `A note named ${file} already exists here.`
  }
  return null
}

function NewNoteRow({ store, parentDir, siblings, onCancel, onCreated }: {
  store: VaultStore
  parentDir: string
  siblings: string[]
  onCancel(): void
  onCreated(path: string): void
}) {
  const [name, setName] = useState('')
  const [serverError, setServerError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const validation = validateNoteName(name, siblings)
  const error = serverError ?? validation
  const commit = async (): Promise<void> => {
    if (busy || validation !== null || name.trim() === '') return
    setBusy(true)
    setServerError(null)
    try {
      onCreated(await store.createNote(parentDir, name))
    } catch (cause) {
      // Keep the row open with the draft intact so the user can fix and retry.
      setServerError(cause instanceof Error ? cause.message : 'Could not create note.')
      setBusy(false)
    }
  }
  return (
    <div className={css.newNoteRow}>
      <div className={`${css.newNoteBox} ${error !== null ? css.newNoteBoxError : ''}`}>
        <FilePlus2 size={13} />
        <input
          autoFocus
          value={name}
          placeholder="Note name"
          aria-label="New note name (extension .md is added automatically)"
          aria-invalid={error !== null}
          disabled={busy}
          onChange={event => { setName(event.target.value); setServerError(null) }}
          onKeyDown={event => {
            if (event.key === 'Enter') { event.preventDefault(); void commit() }
            if (event.key === 'Escape') { event.preventDefault(); onCancel() }
          }}
          onBlur={() => {
            // Match Obsidian: commit a valid non-empty name, otherwise cancel.
            if (busy) return
            if (name.trim() !== '' && validation === null) void commit()
            else onCancel()
          }}
        />
        <span className={css.mdBadge} title="Extension is added automatically">.md</span>
        <button
          className={css.iconButton}
          type="button"
          title="Create note (Enter)"
          aria-label="Create note"
          disabled={busy || validation !== null || name.trim() === ''}
          onMouseDown={event => { event.preventDefault() }}
          onClick={() => { void commit() }}
        >{busy ? <LoaderCircle className={css.spin} size={13} /> : <Check size={13} />}</button>
        <button
          className={css.iconButton}
          type="button"
          title="Cancel (Esc)"
          aria-label="Cancel"
          onMouseDown={event => { event.preventDefault() }}
          onClick={onCancel}
        ><X size={13} /></button>
      </div>
      {error !== null && <div className={css.newNoteError} role="alert">{error}</div>}
    </div>
  )
}

function loadTreePreferences(): TreePreferences {
  const fallback: TreePreferences = { defaultExpanded: true, expandedPaths: {} }
  if (typeof localStorage === 'undefined') return fallback
  try {
    const value = JSON.parse(localStorage.getItem(TREE_PREFERENCES_KEY) ?? '{}') as Partial<TreePreferences>
    const expandedPaths = value.expandedPaths
    return {
      defaultExpanded: typeof value.defaultExpanded === 'boolean' ? value.defaultExpanded : fallback.defaultExpanded,
      expandedPaths: expandedPaths !== null && typeof expandedPaths === 'object' ? expandedPaths as Record<string, boolean> : fallback.expandedPaths,
    }
  } catch {
    return fallback
  }
}
