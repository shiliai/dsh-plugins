import type { ApiErrorPayload, NoteDocument, NoteSearchResult, VaultTreeNode } from '../contracts.ts'

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
  tree: () => request<{ nodes: VaultTreeNode[] }>('/tree'),
  note: (path: string) => request<NoteDocument>(`/note?path=${encodeURIComponent(path)}`),
  search: (query: string) => request<{ results: NoteSearchResult[] }>(`/search?q=${encodeURIComponent(query)}`),
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
}
