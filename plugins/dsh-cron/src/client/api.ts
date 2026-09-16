/**
 * Thin fetch wrapper over /dsh-cron/api. Mutations always send
 * application/json (the host fence rejects cross-site simple requests).
 * @module @dsh-plugins/dsh-cron/client/api
 */

import type { ClientCatalog, ClientState, JobSpecPayload } from './types.ts'

const API = '/dsh-cron/api'

export class CronApiError extends Error {
  constructor(message: string, readonly code: string, readonly status: number, readonly field?: string) {
    super(message)
    this.name = 'CronApiError'
  }
}

async function request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const method = init?.method ?? 'GET'
  const response = await fetch(`${API}${path}`, {
    method,
    ...(init?.body !== undefined
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) }
      : {}),
  })
  if (response.status === 204) return undefined as T
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    payload = undefined
  }
  if (!response.ok) {
    const record = (payload ?? {}) as { error?: string; code?: string; field?: string }
    throw new CronApiError(record.error ?? `请求失败(${response.status})`, record.code ?? 'ERROR', response.status, record.field)
  }
  return payload as T
}

export const cronApi = {
  state: (): Promise<ClientState> => request<ClientState>('/state'),
  catalog: (): Promise<ClientCatalog> => request<ClientCatalog>('/catalog'),
  createJob: (spec: JobSpecPayload): Promise<unknown> => request('/jobs', { method: 'POST', body: spec }),
  updateJob: (id: string, spec: JobSpecPayload): Promise<unknown> => request(`/jobs/${encodeURIComponent(id)}`, { method: 'PUT', body: spec }),
  enable: (id: string): Promise<unknown> => request(`/jobs/${encodeURIComponent(id)}/enable`, { method: 'POST', body: {} }),
  disable: (id: string): Promise<unknown> => request(`/jobs/${encodeURIComponent(id)}/disable`, { method: 'POST', body: {} }),
  runNow: (id: string): Promise<unknown> => request(`/jobs/${encodeURIComponent(id)}/run`, { method: 'POST', body: {} }),
  stop: (id: string): Promise<unknown> => request(`/jobs/${encodeURIComponent(id)}/stop`, { method: 'POST', body: {} }),
  remove: (id: string): Promise<unknown> => request(`/jobs/${encodeURIComponent(id)}`, { method: 'DELETE', body: {} }),
}
