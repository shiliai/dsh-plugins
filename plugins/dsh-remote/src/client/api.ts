import type { RemoteStatus } from '../contracts.ts'

const API = '/dsh-remote/api'

export class RemoteApiError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message)
  }
}

async function request(path: string, init?: RequestInit): Promise<RemoteStatus> {
  const response = await fetch(`${API}${path}`, init)
  if (!response.ok) {
    let payload: { error: string; code: string } = { error: `Remote request failed (${response.status}).`, code: 'REQUEST_FAILED' }
    try { payload = await response.json() as { error: string; code: string } } catch { /* A non-JSON error remains generic. */ }
    throw new RemoteApiError(payload.error, payload.code, response.status)
  }
  return response.json() as Promise<RemoteStatus>
}

export const remoteApi = {
  status: () => request('/status'),
  rotate: () => request('/rotate', { method: 'POST' }),
  reconnect: () => request('/reconnect', { method: 'POST' }),
}
