import type { AgentSkillDocument, AgentSkillInput, AgentSkillListResult, ApiErrorPayload, DirectoryListing, NoteDocument, NoteSearchResult, VaultContextKind, VaultContextReference, VaultTag, VaultTreeNode } from '../contracts.ts'

const API = '/dsh-obsidian/api'

export class VaultApiError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  if (init?.body !== undefined) headers.set('Content-Type', 'application/json')
  const response = await fetch(`${API}${path}`, { ...init, headers })
  if (!response.ok) {
    let payload: ApiErrorPayload = { error: `Vault request failed (${response.status}).`, code: 'REQUEST_FAILED' }
    try { payload = await response.json() as ApiErrorPayload } catch { /* response has no JSON error body */ }
    throw new VaultApiError(payload.error, payload.code, response.status)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export const vaultApi = {
  info: () => request<{ name: string; root: string }>('/info'),
  directories: (path?: string) => request<DirectoryListing>(`/directories${path === undefined ? '' : `?path=${encodeURIComponent(path)}`}`),
  selectVault: (root: string) => request<{ name: string; root: string }>('/vault', {
    method: 'POST',
    body: JSON.stringify({ root }),
  }),
  tree: () => request<{ nodes: VaultTreeNode[] }>('/tree'),
  note: (path: string) => request<NoteDocument>(`/note?path=${encodeURIComponent(path)}`),
  search: (query: string, prefix?: string) => request<{ results: NoteSearchResult[] }>(`/search?q=${encodeURIComponent(query)}${prefix === undefined ? '' : `&prefix=${encodeURIComponent(prefix)}`}`),
  tags: (query?: string) => request<{ tags: VaultTag[] }>(`/tags${query === undefined ? '' : `?q=${encodeURIComponent(query)}`}`),
  tag: (name: string, includeDescendants = true) => request<{ paths: string[] }>(`/tag?name=${encodeURIComponent(name)}&descendants=${String(includeDescendants)}`),
  context: (kind: VaultContextKind, value: string) => request<VaultContextReference>(`/context?kind=${encodeURIComponent(kind)}&value=${encodeURIComponent(value)}`),
  write: (path: string, content: string, expectedModifiedMs?: number) => request<NoteDocument>('/note', {
    method: 'PUT',
    body: JSON.stringify({ path, content, ...(expectedModifiedMs === undefined ? {} : { expectedModifiedMs }) }),
  }),
  move: (from: string, to: string) => request<NoteDocument>('/move', {
    method: 'POST',
    body: JSON.stringify({ from, to }),
  }),
  delete: (path: string) => request<void>(`/note?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
  assetUrl: (path: string) => `${API}/asset?path=${encodeURIComponent(path)}`,

  skillList: () => request<{ result: AgentSkillListResult }>('/skills'),
  skillGet: (name: string) => request<AgentSkillDocument>(`/skill?name=${encodeURIComponent(name)}`),
  skillWrite: (payload: { input: AgentSkillInput; previousName?: string; expectedRevision?: string }) => request<{ result: { value: AgentSkillDocument } }>('/skill', {
    method: 'PUT',
    body: JSON.stringify({
      skill: payload.input,
      ...(payload.previousName === undefined ? {} : { previousName: payload.previousName }),
      ...(payload.expectedRevision === undefined ? {} : { expectedRevision: payload.expectedRevision }),
    }),
  }),
  skillDelete: (name: string, expectedRevision: string) => request<{ result: { value: void } }>(`/skill?name=${encodeURIComponent(name)}&expectedRevision=${encodeURIComponent(expectedRevision)}`, { method: 'DELETE' }),
}
