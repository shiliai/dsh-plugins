import { describe, expect, it, vi } from 'vitest'
import { registerWecomApi } from '../src/http-api.ts'
import type { WecomStatus } from '../src/lifecycle.ts'

const online: WecomStatus = { state: 'online', changedAt: 1, authenticatedAt: 1, restarting: false, version: '0.2.0' }
const ORIGIN = 'http://127.0.0.1:3180'

function fixture(controller: { getStatus(): WecomStatus; restart(): Promise<WecomStatus> }, origin = ORIGIN) {
  let handler: ((request: never, response: never) => Promise<void>) | undefined
  registerWecomApi({ register: (route: { handler: typeof handler }) => { handler = route.handler; return () => {} } } as never, controller as never, origin)
  return async (method: string, url: string, headers: Record<string, string> = {}) => {
    let status = 0
    let body = ''
    const response = { headersSent: false, writeHead: vi.fn((next: number) => { status = next; response.headersSent = true }), end: vi.fn((next: string) => { body = next }), destroy: vi.fn() }
    await handler!({ method, url, headers } as never, response as never)
    return { status, payload: body === '' ? undefined : JSON.parse(body) as Record<string, unknown>, response }
  }
}

describe('WeCom status API', () => {
  it('returns status and a completed restart snapshot', async () => {
    const restart = vi.fn(async () => online)
    const request = fixture({ getStatus: () => online, restart })
    expect(await request('GET', '/dsh-wecom/api/status')).toMatchObject({ status: 200, payload: { restarting: false } })
    expect(await request('POST', '/dsh-wecom/api/restart', { origin: ORIGIN, 'sec-fetch-site': 'same-origin' })).toMatchObject({ status: 200, payload: { restarting: false } })
  })

  it.each([
    [{ origin: 'https://127.0.0.1:3180', 'sec-fetch-site': 'same-origin' }],
    [{ origin: 'http://127.0.0.1:3181', 'sec-fetch-site': 'same-origin' }],
    [{ origin: 'http://attacker.invalid', 'sec-fetch-site': 'same-origin' }],
    [{ origin: 'http://user@127.0.0.1:3180', 'sec-fetch-site': 'same-origin' }],
    [{ origin: ORIGIN, 'sec-fetch-site': 'cross-site' }],
    [{ origin: 'not a url' }],
    [{}],
  ])('denies malformed, spoofed, cross-scheme, or cross-site restart requests', async headers => {
    const restart = vi.fn(async () => online)
    const result = await fixture({ getStatus: () => online, restart })('POST', '/dsh-wecom/api/restart', headers)
    expect(result).toMatchObject({ status: 403, payload: { code: 'ORIGIN_DENIED' } })
    expect(restart).not.toHaveBeenCalled()
  })

  it('returns safe unknown-route and unexpected-failure responses', async () => {
    const request = fixture({ getStatus: () => online, restart: async () => { const error = new Error('bot-secret'); error.name = 'token-value'; throw error } })
    expect(await request('GET', '/dsh-wecom/api/nope')).toMatchObject({ status: 404, payload: { code: 'NOT_FOUND' } })
    const result = await request('POST', '/dsh-wecom/api/restart', { origin: ORIGIN, 'sec-fetch-site': 'same-origin' })
    expect(result).toMatchObject({ status: 500, payload: { code: 'INTERNAL_ERROR', error: 'WeCom request failed.' } })
    expect(JSON.stringify(result.payload)).not.toContain('token-value')
  })
})
