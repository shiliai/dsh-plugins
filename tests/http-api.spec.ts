import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteStatus } from '../src/contracts.ts'
import { registerRemoteApi } from '../src/http-api.ts'
import type { RemoteService } from '../src/remote-service.ts'

const servers: Server[] = []
const status: RemoteStatus = {
  accessUrl: 'https://zsh.onlyservice.io/#/access/redacted',
  gatewayPort: 4040,
  sessionVersion: 1,
  tunnel: { phase: 'online', attempts: 1, reason: null },
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error === undefined ? resolve() : reject(error))
  })))
})

describe('registerRemoteApi', () => {
  it('returns status and requires one exact allowed Origin for rotation and reconnect', async () => {
    let handler: ((request: IncomingMessage, response: ServerResponse) => Promise<void>) | undefined
    const service = {
      status: vi.fn(() => status),
      rotate: vi.fn(async () => ({ ...status, sessionVersion: 2 })),
      reconnect: vi.fn(() => status),
    } as unknown as RemoteService
    const dispose = registerRemoteApi({ register: vi.fn(route => {
      handler = route.handler
      return vi.fn()
    }) } as never, service, ['http://127.0.0.1:3080', 'https://zsh.onlyservice.io'])
    expect(typeof dispose).toBe('function')
    if (handler === undefined) throw new Error('Remote API route was not registered.')
    const server = createServer((request, response) => { void handler?.(request, response) })
    servers.push(server)
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Expected local API port.')
    const baseUrl = `http://127.0.0.1:${address.port}`

    expect((await fetch(`${baseUrl}/dsh-remote/api/status`)).status).toBe(200)
    expect((await fetch(`${baseUrl}/dsh-remote/api/rotate`, { method: 'POST' })).status).toBe(403)
    expect((await fetch(`${baseUrl}/dsh-remote/api/rotate`, { method: 'POST', headers: { origin: 'http://127.0.0.1:3080/' } })).status).toBe(403)
    const rotated = await fetch(`${baseUrl}/dsh-remote/api/rotate`, { method: 'POST', headers: { origin: 'https://zsh.onlyservice.io' } })
    expect(rotated.status).toBe(200)
    expect(await rotated.json()).toMatchObject({ sessionVersion: 2 })
    expect(service.rotate).toHaveBeenCalledOnce()
    expect((await fetch(`${baseUrl}/dsh-remote/api/reconnect`, { method: 'POST', headers: { origin: 'http://127.0.0.1:3080' } })).status).toBe(200)
  })
})
