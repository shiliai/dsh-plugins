import { useEffect, useMemo, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import ArrowLeft from 'lucide-react/dist/esm/icons/arrow-left'
import ArrowUp from 'lucide-react/dist/esm/icons/arrow-up'
import Check from 'lucide-react/dist/esm/icons/check'
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

export function VaultBrowser({ store, closeBrowser, wide, expandSidebar, addContextToChat }: Props) {
  const state = store.useSnapshot()
  const directoryListing = state.directoryListing
  const [newPath, setNewPath] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

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
        <button className={css.iconButton} type="button" title="New note" aria-label="New note" onClick={() => { setNewPath('') }}>
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
        {newPath !== null && (
          <form className={css.newNote} onSubmit={(event) => {
            event.preventDefault()
            if (newPath.trim() !== '') void store.createNote(newPath)
            setNewPath(null)
          }}>
            <input autoFocus value={newPath} placeholder="Folder/Note.md" aria-label="New note path" onChange={event => { setNewPath(event.target.value) }} />
            <button className={css.iconButton} type="submit" title="Create note" aria-label="Create note" disabled={newPath.trim() === ''}><Check size={14} /></button>
            <button className={css.iconButton} type="button" title="Cancel" aria-label="Cancel" onClick={() => { setNewPath(null) }}><X size={14} /></button>
          </form>
        )}

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

        {feedback !== null && <div className={feedback.kind === 'success' ? css.inlineSuccess : css.inlineError} role={feedback.kind === 'success' ? 'status' : 'alert'}>{feedback.text}</div>}
        {state.error !== null && <div className={css.inlineError} role="alert">{state.error}</div>}

        <div
          className={css.tree}
          role={state.view === 'notes' && state.query.trim() === '' ? 'tree' : undefined}
          aria-label={state.view === 'notes' ? 'Notes' : 'Tags'}
          onContextMenu={event => {
            if (state.view === 'notes' && state.query.trim() !== '' && state.searchResults.length > 0) openContextMenu(event, searchTarget)
            else if (tagTarget !== null && state.tagPaths.length > 0) openContextMenu(event, tagTarget)
          }}
        >
          {state.view === 'notes' && state.query.trim() === '' && state.tree.map(node => (
            <TreeNode key={node.path} node={node} activePath={state.active?.path} open={path => { void store.openNote(path) }} openMenu={openContextMenu} add={target => { void addContext(target) }} />
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

function TreeNode({ node, activePath, open, openMenu, add }: {
  node: VaultTreeNode
  activePath: string | undefined
  open(path: string): void
  openMenu(event: ReactMouseEvent, target: ContextTarget): void
  add(target: ContextTarget): void
}) {
  const [expanded, setExpanded] = useState(true)
  const childCount = useMemo(() => node.children?.length ?? 0, [node.children])
  const target = { kind: node.type === 'note' ? 'note' as const : 'directory' as const, value: node.path, label: node.path }
  if (node.type === 'note') {
    return (
      <div role="treeitem" aria-selected={activePath === node.path}>
        <ContextRow target={target} openMenu={openMenu} add={add}>
          <button className={`${css.treeRow} ${activePath === node.path ? css.active : ''}`} type="button" onClick={() => { open(node.path) }}>
            <FileText size={14} /><span>{node.name.replace(/\.md$/iu, '')}</span>
          </button>
        </ContextRow>
      </div>
    )
  }
  return (
    <div role="treeitem" aria-expanded={expanded}>
      <ContextRow target={target} openMenu={openMenu} add={add}>
        <button className={css.treeRow} type="button" onClick={() => { setExpanded(value => !value) }}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
          <span>{node.name}</span><small>{childCount}</small>
        </button>
      </ContextRow>
      {expanded && <div className={css.treeChildren} role="group">{node.children?.map(child => <TreeNode key={child.path} node={child} activePath={activePath} open={open} openMenu={openMenu} add={add} />)}</div>}
    </div>
  )
}
