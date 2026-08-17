export interface VaultTreeNode {
  name: string
  path: string
  type: 'directory' | 'note'
  children?: VaultTreeNode[]
  modifiedMs?: number
}

export interface NoteDocument {
  path: string
  content: string
  modifiedMs: number
  size: number
}

export interface NoteSearchResult {
  path: string
  line: number
  excerpt: string
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
