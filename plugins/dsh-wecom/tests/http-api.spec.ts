import { describe, expect, it, vi } from 'vitest'
import { registerWecomApi } from '../src/http-api.ts'
import type { WecomStatus } from '../src/lifecycle.ts'

const online: WecomStatus = { state: 'online', changedAt: 1, authenticatedAt: 1, restarting: false, version: '0.1.1' }

function fixture(controller: { getStatus(): WecomStatus; restart(): Promise<WecomStatus> }) {
  let handler: ((request: never, response: never) => Promise<void>) | undefined
  registerWecomApi({ register: (route: { handler: typeof handler }) => { handler = route.handler; return () => {} } } as never, controller as never)
  return async (method: string, url: string, headers: Record<string, string> = {}) => {
    let status = 0
    let body = ''
    const response = {
      headersSent: false,
      writeHead: vi.fn((next: number) => { status = next; response.headersSent = true }),
      end: vi.fn((next: string) => { body = next }),
      destroy: vi.fn(),
    }
    await handler!({ method, url, headers } as never, response as never)
    return { status, payload: body === '' ? undefined : JSON.parse(body) as Record<string, unknown>, response }
  }
}

describe('WeCom status API', () => {
  it('returns the safe status snapshot', async () => {
    const request = fixture({ getStatus: () => online, restart: async () => online })
    const result = await request('GET', '/dsh-wecom/api/status')
    expect(result.status).toBe(200)
    expect(result.payload).toEqual(online)
  })

  it('allows a same-origin restart', async () => {
    const restart = vi.fn(async () => online)
    const request = fixture({ getStatus: () => online, restart })
    const result = await request('POST', '/dsh-wecom/api/restart', { host: 'dsh.local:3180', origin: 'https://dsh.local:3180' })
    expect(result.status).toBe(200)
    expect(restart).toHaveBeenCalledOnce()
  })

  it.each([
    [{ host: 'dsh.local:3180', origin: 'https://other.local:3180' }],
    [{ host: 'dsh.local:3180' }],
  ])('denies restart requests without same-origin authority', async headers => {
    const restart = vi.fn(async () => online)
    const request = fixture({ getStatus: () => online, restart })
    const result = await request('POST', '/dsh-wecom/api/restart', headers)
    expect(result).toMatchObject({ status: 403, payload: { code: 'ORIGIN_DENIED' } })
    expect(restart).not.toHaveBeenCalled()
  })

  it('returns a safe 404 for unknown routes', async () => {
    const request = fixture({ getStatus: () => online, restart: async () => online })
    expect(await request('GET', '/dsh-wecom/api/nope')).toMatchObject({ status: 404, payload: { code: 'NOT_FOUND' } })
  })

  it('redacts unexpected restart failures in a bounded 500 response', async () => {
    const request = fixture({ getStatus: () => online, restart: async () => { throw new Error('bot-secret and message body') } })
    const result = await request('POST', '/dsh-wecom/api/restart', { host: 'dsh.local', origin: 'https://dsh.local' })
    expect(result).toMatchObject({ status: 500, payload: { code: 'INTERNAL_ERROR', error: 'WeCom request failed.' } })
    expect(JSON.stringify(result.payload)).not.toContain('bot-secret')
  })
})
