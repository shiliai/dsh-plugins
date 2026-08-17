import { useEffect, useMemo, useState } from 'react'
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
import Search from 'lucide-react/dist/esm/icons/search'
import X from 'lucide-react/dist/esm/icons/x'
import type { VaultTreeNode } from '../contracts.ts'
import type { VaultStore } from './store.ts'
import css from './styles.module.css?dsh-inline'

interface Props {
  store: VaultStore
  closeBrowser(): void
  wide: boolean
  expandSidebar(): void
}

export function VaultBrowser({ store, closeBrowser, wide, expandSidebar }: Props) {
  const state = store.useSnapshot()
  const directoryListing = state.directoryListing
  const [newPath, setNewPath] = useState<string | null>(null)

  useEffect(() => {
    void store.initialize()
    const interval = window.setInterval(() => { void store.refreshTree() }, 5000)
    return () => { window.clearInterval(interval) }
  }, [store])

  if (!wide) {
    return (
      <button className={css.railButton} type="button" title="Open vault" aria-label="Open vault" onClick={expandSidebar}>
        <FolderOpen size={18} />
      </button>
    )
  }

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

      <label className={css.searchBox}>
        <Search size={15} />
        <input
          value={state.query}
          placeholder="Search notes"
          aria-label="Search notes"
          onChange={event => { void store.search(event.target.value) }}
        />
        {state.loadingTree && <LoaderCircle className={css.spin} size={14} />}
      </label>

      {state.error !== null && <div className={css.inlineError} role="alert">{state.error}</div>}
      <div className={css.tree} role="tree" aria-label="Notes">
        {state.query.trim() === ''
          ? state.tree.map(node => <TreeNode key={node.path} node={node} activePath={state.active?.path} open={path => { void store.openNote(path) }} />)
          : state.searchResults.map(result => (
            <button key={`${result.path}:${result.line}`} className={css.searchResult} type="button" onClick={() => { void store.openNote(result.path) }}>
              <span><FileText size={14} />{result.path}</span>
              <small>{result.line > 0 ? `L${result.line} ` : ''}{result.excerpt}</small>
            </button>
          ))}
      </div>
      </>}
    </section>
  )
}

function TreeNode({ node, activePath, open }: { node: VaultTreeNode; activePath: string | undefined; open(path: string): void }) {
  const [expanded, setExpanded] = useState(true)
  const childCount = useMemo(() => node.children?.length ?? 0, [node.children])
  if (node.type === 'note') {
    return (
      <button
        className={`${css.treeRow} ${activePath === node.path ? css.active : ''}`}
        type="button"
        role="treeitem"
        aria-selected={activePath === node.path}
        onClick={() => { open(node.path) }}
      >
        <FileText size={14} /><span>{node.name.replace(/\.md$/iu, '')}</span>
      </button>
    )
  }
  return (
    <div role="treeitem" aria-expanded={expanded}>
      <button className={css.treeRow} type="button" onClick={() => { setExpanded(value => !value) }}>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
        <span>{node.name}</span><small>{childCount}</small>
      </button>
      {expanded && <div className={css.treeChildren} role="group">{node.children?.map(child => <TreeNode key={child.path} node={child} activePath={activePath} open={open} />)}</div>}
    </div>
  )
}
