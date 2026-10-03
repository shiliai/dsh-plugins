/** Issue #137 follow-up: workspace-consistency state for the workbench chip. */

import { useSyncExternalStore } from 'react'

/** The fields of a host workspace row the chip needs. */
export interface WorkspaceSummary {
  workspaceId: string
  path: string
  title: string
  sessionIds: readonly string[]
}

/** Loose structural view of the faces the chip reads; both may be absent. */
export interface WorkspaceStatusSource {
  sessions?: {
    subscribe(listener: () => void): () => void
    getSnapshot(): {
      current: string | undefined
      byId: Record<string, { cwd?: string; blank?: boolean; displayTitle?: string; title?: string }>
    }
  } | undefined
  workspaces?: {
    subscribe(listener: () => void): () => void
    getSnapshot(): { items?: readonly WorkspaceSummary[] }
  } | undefined
}

/** Chip state: conversation targets the vault (`vault`), another workspace (`other`), or undeterminable (`unknown`). */
export type WorkspaceState = 'vault' | 'other' | 'unknown'

const NOOP_SUBSCRIBE = (): (() => void) => () => {}
const EMPTY_SESSIONS = { current: undefined, byId: {} as Record<string, { cwd?: string; blank?: boolean; displayTitle?: string; title?: string }> }
const EMPTY_WORKSPACES: { items?: readonly WorkspaceSummary[] } = {}

/**
 * Path comparison for "does this conversation write into the vault".
 * Case-insensitive (macOS default filesystem) with trailing-slash trimming.
 * Deliberately NOT realpath: symlinks degrade to string equality by design
 * (documented in docs/design-obsidian-mode-exit-and-workspace.md §6.1).
 */
export function samePath(a: string, b: string): boolean {
  if (a === '' || b === '') return false
  return a.replace(/\/+$/u, '').toLocaleLowerCase() === b.replace(/\/+$/u, '').toLocaleLowerCase()
}

/**
 * Decide the chip state. The session's own cwd is the primary source (it is
 * the fact that decides where generated files land); workspace group
 * membership is only a fallback because that snapshot is the same secondary
 * projection whose invisibility motivated the chip in the first place.
 */
export function inferWorkspaceState(input: {
  vaultRoot: string
  currentSessionId: string | undefined
  sessionCwd: string | undefined
  workspaces: readonly WorkspaceSummary[] | undefined
}): WorkspaceState {
  if (input.vaultRoot === '') return 'unknown'
  if (input.sessionCwd !== undefined) return samePath(input.sessionCwd, input.vaultRoot) ? 'vault' : 'other'
  if (input.workspaces !== undefined && input.currentSessionId !== undefined) {
    const vaultWorkspace = input.workspaces.find(workspace => samePath(workspace.path, input.vaultRoot))
    if (vaultWorkspace !== undefined && vaultWorkspace.sessionIds.includes(input.currentSessionId)) return 'vault'
  }
  return 'unknown'
}

/** `Obsidian · <basename>`, appending the parent directory name when the base name is taken. */
export function vaultWorkspaceTitle(vaultRoot: string, existingTitles: readonly string[]): string {
  const segments = vaultRoot.split('/').filter(segment => segment !== '')
  const base = segments.at(-1) ?? vaultRoot
  const parent = segments.at(-2)
  const desired = `Obsidian · ${base}`
  const taken = new Set(existingTitles)
  if (!taken.has(desired)) return desired
  return parent === undefined ? desired : `Obsidian · ${base} (${parent})`
}

export interface WorkspaceStatus {
  state: WorkspaceState
  currentSessionId: string | undefined
  /** Host display title of the current session, when known. */
  sessionTitle: string | undefined
  /** Whether the current session is still blank (no durable log). */
  sessionBlank: boolean | undefined
  /** The session's own working directory, when the host exposes one. */
  sessionCwd: string | undefined
  /** The workspace row matching the vault root, when listed. */
  vaultWorkspace: WorkspaceSummary | undefined
}

/**
 * React binding for the chip: subscribes to both faces and re-runs the pure
 * inference on every snapshot change. Tolerates either face being absent
 * (host/registry differences) by reading `undefined` snapshots.
 */
export function useWorkspaceStatus(source: WorkspaceStatusSource | undefined, vaultRoot: string): WorkspaceStatus {
  const sessions = useSyncExternalStore(
    source?.sessions?.subscribe ?? NOOP_SUBSCRIBE,
    source?.sessions?.getSnapshot ?? (() => EMPTY_SESSIONS),
    source?.sessions?.getSnapshot ?? (() => EMPTY_SESSIONS),
  )
  const workspaces = useSyncExternalStore(
    source?.workspaces?.subscribe ?? NOOP_SUBSCRIBE,
    source?.workspaces?.getSnapshot ?? (() => EMPTY_WORKSPACES),
    source?.workspaces?.getSnapshot ?? (() => EMPTY_WORKSPACES),
  )
  const items = workspaces.items
  const currentSessionId = sessions?.current
  const session = currentSessionId !== undefined ? sessions?.byId[currentSessionId] : undefined
  const sessionCwd = session?.cwd
  const state = inferWorkspaceState({ vaultRoot, currentSessionId, sessionCwd, workspaces: items })
  return {
    state,
    currentSessionId,
    sessionTitle: session?.displayTitle ?? session?.title,
    sessionBlank: session?.blank,
    sessionCwd,
    vaultWorkspace: items?.find(workspace => samePath(workspace.path, vaultRoot)),
  }
}
