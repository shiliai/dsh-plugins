export interface VaultTreeNode {
  name: string
  path: string
  type: 'directory' | 'note'
  children?: VaultTreeNode[]
  modifiedMs?: number
}

export interface NoteDocument {
  path: string
  absolutePath: string
  content: string
  modifiedMs: number
  size: number
}

export interface NoteSearchResult {
  path: string
  line: number
  excerpt: string
}

export interface VaultTag {
  name: string
  count: number
}

export type VaultContextKind = 'note' | 'directory' | 'tag' | 'search'

export interface VaultContextEntry {
  path: string
  absolutePath: string
}

export interface VaultContextReference {
  kind: VaultContextKind
  vaultRoot: string
  value: string
  absolutePath?: string
  entries: VaultContextEntry[]
}

export interface DirectoryEntry {
  name: string
  path: string
}

/** The filesystem entry kinds a vault browser row can point at. */
export type VaultEntryKind = 'note' | 'directory'

/**
 * Everything the vault browser shows in its "Properties" dialog. Note-only
 * text statistics stay optional because a note above `maxNoteBytes` is not
 * read; directory counts are direct children with hidden entries excluded,
 * matching what the tree lists.
 */
export interface VaultEntryProperty {
  path: string
  name: string
  kind: VaultEntryKind
  absolutePath: string
  size: number
  createdMs: number
  modifiedMs: number
  accessedMs: number
  /** POSIX permission triple, e.g. `drwxr-xr-x` or `-rw-r--r--`. */
  permissions: string
  lines?: number
  words?: number
  characters?: number
  tags?: string[]
  files?: number
  directories?: number
}

/**
 * One "Open with" choice. The default handler is always offered; named apps
 * come from a fixed catalog, and the host resolves them against its own
 * filesystem so the browser can never name an arbitrary executable.
 */
export interface VaultOpener {
  id: string
  label: string
  /** True for the operating system's default application. */
  default?: boolean
}

/**
 * The host desktop's "reveal in the file manager" action for one entry. It is
 * offered alongside the openers because it needs the host's platform label and
 * its launcher, but it is not an application: `null` when the host has no
 * desktop to reveal in.
 */
export interface VaultRevealAction {
  id: 'reveal'
  label: string
}

export interface DirectoryListing {
  path: string
  parent: string | null
  directories: DirectoryEntry[]
}

export interface ApiErrorPayload {
  error: string
  code: string
}

export interface AgentSkillSummary {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
  directoryPath: string
}

export interface AgentSkillDocument extends AgentSkillSummary {
  instructions: string
  frontmatter: Record<string, unknown>
  filePath: string
  revision: string
}

export interface AgentSkillInput {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
  instructions: string
}

export interface AgentSkillDiagnostic {
  directoryPath: string
  message: string
}

export interface AgentSkillListResult {
  skills: AgentSkillDocument[]
  diagnostics: AgentSkillDiagnostic[]
}

export type ThoughtStatus = 'inbox' | 'next' | 'done'
export interface Thought { id: string; date: string; text: string; status: ThoughtStatus; created: string; file: string; archived?: boolean; deletedAt?: string }
