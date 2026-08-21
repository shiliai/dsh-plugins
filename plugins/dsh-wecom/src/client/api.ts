import type { WecomStatus } from '../lifecycle.ts'

const API = '/dsh-wecom/api'

async function request(path: string, init?: RequestInit): Promise<WecomStatus> {
  const response = await fetch(`${API}${path}`, init)
  if (!response.ok) throw new Error('WeCom status request failed.')
  return response.json() as Promise<WecomStatus>
}

export const wecomApi = {
  status: () => request('/status'),
  restart: () => request('/restart', { method: 'POST' }),
}
