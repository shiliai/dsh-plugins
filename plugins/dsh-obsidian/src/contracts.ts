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
