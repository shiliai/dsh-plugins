import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { RemoteGateway } from '../src/gateway.ts'
import { RemoteStateStore } from '../src/state-store.ts'

const roots: string[] = []
const servers: Server[] = []
const gateways: RemoteGateway[] = []
const webSocketServers: WebSocketServer[] = []

afterEach(async () => {
  await Promise.all(gateways.splice(0).map(gateway => gateway.close()))
  for (const server of webSocketServers.splice(0)) {
    for (const client of server.clients) client.terminate()
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
  }
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error === undefined ? resolve() : reject(error))
  })))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ baseUrl: string; state: RemoteStateStore; gateway: RemoteGateway }> {
  const target = createServer((request, response) => {
    const body = JSON.stringify({ path: request.url, cookie: request.headers.cookie ?? null })
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
    response.end(body)
  })
  const webSocketServer = new WebSocketServer({ noServer: true })
  webSocketServers.push(webSocketServer)
  target.on('upgrade', (request, socket, head) => {
    webSocketServer.handleUpgrade(request, socket, head, connection => {
      connection.on('message', message => { connection.send(message) })
    })
  })
  servers.push(target)
  await listen(target)
  const address = target.address()
  if (address === null || typeof address === 'string') throw new Error('Expected local HTTP target port.')

  const root = await mkdtemp(join(tmpdir(), 'dsh-remote-gateway-'))
  roots.push(root)
  const state = await RemoteStateStore.open(join(root, 'state.json'))
  const gateway = new RemoteGateway({ targetPort: address.port, remoteOrigin: 'https://zsh.onlyservice.io', state })
  await gateway.listen()
  gateways.push(gateway)
  return { baseUrl: `http://127.0.0.1:${gateway.port}`, state, gateway }
}

describe('RemoteGateway', () => {
  it('exchanges a fragment bearer for a hardened cookie then proxies authenticated HTTP without forwarding it', async () => {
    const { baseUrl, state } = await fixture()
    const bootstrap = await fetch(`${baseUrl}/`)
    expect(bootstrap.status).toBe(200)
    expect(bootstrap.headers.get('cache-control')).toBe('no-store')
    expect(bootstrap.headers.get('referrer-policy')).toBe('no-referrer')
    expect(await bootstrap.text()).toContain('history.replaceState')

    expect((await fetch(`${baseUrl}/complete`)).status).toBe(401)
    expect((await fetch(`${baseUrl}/__dsh_remote/session`, {
      method: 'POST',
      headers: { origin: 'https://attacker.invalid', 'content-type': 'application/json' },
      body: JSON.stringify(Object.fromEntries([['token', state.accessToken()]])),
    })).status).toBe(403)

    const session = await fetch(`${baseUrl}/__dsh_remote/session`, {
      method: 'POST',
      headers: { origin: 'https://zsh.onlyservice.io', 'content-type': 'application/json' },
      body: JSON.stringify(Object.fromEntries([['token', state.accessToken()]])),
    })
    expect(session.status).toBe(204)
    const cookie = session.headers.getSetCookie()[0]?.split(';', 1)[0]
    expect(cookie).toMatch(/^__Host-dsh_remote=\d+\.[A-Za-z0-9_-]{43}$/u)

    const proxied = await fetch(`${baseUrl}/complete`, { headers: { cookie: `${cookie}; dsh=preserved` } })
    expect(proxied.status).toBe(200)
    expect(await proxied.json()).toEqual({ path: '/complete', cookie: 'dsh=preserved' })
  })

  it('authenticates each WebSocket upgrade and closes every old upgraded socket before rotation returns', async () => {
    const { baseUrl, state, gateway } = await fixture()
    const cookie = await issueSession(baseUrl, state.accessToken())
    const socket = new WebSocket(baseUrl.replace('http:', 'ws:'), { headers: { cookie } })
    await once(socket, 'open')
    socket.send('realtime')
    await expectMessage(socket, 'realtime')

    const next = await state.rotate()
    gateway.closeSessionsBefore(next.sessionVersion)
    await once(socket, 'close')

    expect((await fetch(`${baseUrl}/after-rotation`, { headers: { cookie } })).status).toBe(401)
    expect((await fetch(`${baseUrl}/__dsh_remote/session`, {
      method: 'POST',
      headers: { origin: 'https://zsh.onlyservice.io', 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'x'.repeat(43) }),
    })).status).toBe(403)
    const replacement = await issueSession(baseUrl, state.accessToken())
    expect((await fetch(`${baseUrl}/after-rotation`, { headers: { cookie: replacement } })).status).toBe(200)
  })
})

async function issueSession(baseUrl: string, token: string): Promise<string> {
  const response = await fetch(`${baseUrl}/__dsh_remote/session`, {
    method: 'POST',
    headers: { origin: 'https://zsh.onlyservice.io', 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  if (response.status !== 204) throw new Error(`Expected session response, got ${response.status}.`)
  const cookie = response.headers.getSetCookie()[0]?.split(';', 1)[0]
  if (cookie === undefined) throw new Error('Expected remote session cookie.')
  return cookie
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}

function once(socket: WebSocket, event: 'open' | 'close'): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once(event, () => { resolve() })
    socket.once('error', reject)
  })
}

function expectMessage(socket: WebSocket, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('message', message => { message.toString() === expected ? resolve() : reject(new Error('Unexpected WebSocket message.')) })
    socket.once('error', reject)
  })
}
