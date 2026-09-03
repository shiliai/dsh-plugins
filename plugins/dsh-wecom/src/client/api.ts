import type { WecomStatus } from '../lifecycle.ts'
import type { CliUpdateStatus } from '../cli-update.ts'

const API = '/dsh-wecom/api'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, init)
  if (!response.ok) throw new Error('WeCom status request failed.')
  return response.json() as Promise<T>
}

export const wecomApi = {
  status: () => request<WecomStatus>('/status'),
  restart: () => request<WecomStatus>('/restart', { method: 'POST' }),
  checkCliUpdate: () => request<CliUpdateStatus>('/wecom-cli-update'),
  updateCli: () => request<CliUpdateStatus>('/wecom-cli-update', { method: 'POST' }),
}
