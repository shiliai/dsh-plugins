import { createServer, type Server } from 'node:http'
import { createConnection, createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net'
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
const webSocketRequests: Array<{ origin: string | undefined; host: string | undefined; cookie: string | null }> = []
const agentServers: NetServer[] = []

afterEach(async () => {
  await Promise.all(gateways.splice(0).map(gateway => gateway.close()))
  for (const server of webSocketServers.splice(0)) {
    for (const client of server.clients) client.terminate()
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
  }
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error === undefined ? resolve() : reject(error))
  })))
  await Promise.all(agentServers.splice(0).map(server => new Promise<void>(resolve => { server.close(() => { resolve() }) })))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  webSocketRequests.length = 0
})

async function fixture(
  agentSocketPath?: string,
  gatewayOptions: { now?: () => number; hostSessionTtlMs?: number } = {},
): Promise<{ baseUrl: string; state: RemoteStateStore; gateway: RemoteGateway; upstreamOrigin: string }> {
  const target = createServer((request, response) => {
    const body = JSON.stringify({
      path: request.url,
      cookie: request.headers.cookie ?? null,
      origin: request.headers.origin ?? null,
      host: request.headers.host ?? null,
      ownerMarker: request.headers['x-dsh-remote-owner'] ?? null,
    })
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
    response.end(body)
  })
  const webSocketServer = new WebSocketServer({ noServer: true })
  webSocketServers.push(webSocketServer)
  target.on('upgrade', (request, socket, head) => {
    webSocketServer.handleUpgrade(request, socket, head, connection => {
      webSocketRequests.push({ origin: request.headers.origin, host: request.headers.host, cookie: request.headers.cookie ?? null })
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
  const gateway = new RemoteGateway({
    targetPort: address.port, remoteOrigin: 'https://zsh.onlyservice.io', state,
    ...(agentSocketPath === undefined ? {} : { agentSocketPath }),
    ...gatewayOptions,
  })
  await gateway.listen()
  gateways.push(gateway)
  return { baseUrl: `http://127.0.0.1:${gateway.port}`, state, gateway, upstreamOrigin: `http://127.0.0.1:${address.port}` }
}

describe('RemoteGateway', () => {
  it('keeps serving after an accepted gateway socket emits a late reset error', async () => {
    const { baseUrl, gateway } = await fixture()
    const target = new URL(baseUrl)
    const server = (gateway as unknown as { server: Server }).server
    const accepted = new Promise<Socket>(resolve => { server.once('connection', resolve) })
    const client = createConnection({ host: target.hostname, port: Number(target.port) })
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve)
      client.once('error', reject)
    })
    const socket = await accepted
    const closed = new Promise<void>(resolve => { socket.once('close', () => { resolve() }) })
    client.destroy()
    await closed
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    expect(() => { socket.emit('error', reset) }).not.toThrow()
    expect((await fetch(`${baseUrl}/`)).status).toBe(200)
  })

  it('exchanges a fragment bearer for a hardened cookie then proxies authenticated HTTP without forwarding it', async () => {
    const { baseUrl, state, upstreamOrigin } = await fixture()
    const bootstrap = await fetch(`${baseUrl}/`)
    expect(bootstrap.status).toBe(200)
    expect(bootstrap.headers.get('cache-control')).toBe('no-store')
    expect(bootstrap.headers.get('referrer-policy')).toBe('no-referrer')
    expect(bootstrap.headers.get('content-security-policy')).toContain("connect-src 'self'")
    expect(bootstrap.headers.get('keep-alive')).toBe('timeout=60')
    expect(await bootstrap.text()).toContain('history.replaceState')

    expect((await fetch(`${baseUrl}/complete`)).status).toBe(401)
    expect((await fetch(`${baseUrl}/__dsh_remote/session`, {
      method: 'POST',
      headers: { origin: 'https://attacker.invalid', 'content-type': 'application/json' },
      body: JSON.stringify(Object.fromEntries([['token', state.accessToken()]])),
    })).status).toBe(403)
    for (const malformed of ['界'.repeat(43), '!'.repeat(43), 'a'.repeat(44)]) {
      expect((await fetch(`${baseUrl}/__dsh_remote/session`, {
        method: 'POST',
        headers: { origin: 'https://zsh.onlyservice.io', 'content-type': 'application/json' },
        body: JSON.stringify({ token: malformed }),
      })).status).toBe(403)
    }

    const session = await fetch(`${baseUrl}/__dsh_remote/session`, {
      method: 'POST',
      headers: { origin: 'https://zsh.onlyservice.io', 'content-type': 'application/json' },
      body: JSON.stringify(Object.fromEntries([['token', state.accessToken()]])),
    })
    expect(session.status).toBe(204)
    const cookie = session.headers.getSetCookie()[0]?.split(';', 1)[0]
    expect(cookie).toMatch(/^__Host-dsh_remote=\d+\.[A-Za-z0-9_-]{43}$/u)

    const proxied = await fetch(`${baseUrl}/complete`, { headers: { cookie: `${cookie}; dsh=preserved`, origin: 'https://zsh.onlyservice.io' } })
    expect(proxied.status).toBe(200)
    expect(await proxied.json()).toEqual({
      path: '/complete', cookie: 'dsh=preserved', origin: upstreamOrigin,
      host: new URL(upstreamOrigin).host, ownerMarker: null,
    })

    for (const method of [...PRIVILEGED_METHODS, ...NON_CONFIGURATION_LOOPBACK_METHODS]) {
      const denied = await fetch(`${baseUrl}/api/${method}`, {
        method: 'POST',
        headers: { cookie: `${cookie}`, origin: 'https://zsh.onlyservice.io', 'x-dsh-remote-owner': 'owner' },
      })
      expect(denied.status, method).toBe(403)
    }
    const ordinary = await fetch(`${baseUrl}/api/llm.providers`, {
      method: 'POST',
      headers: { cookie: `${cookie}`, origin: 'https://zsh.onlyservice.io', 'x-dsh-remote-owner': 'owner' },
    })
    expect(ordinary.status).toBe(200)
    expect((await ordinary.json()).ownerMarker).toBeNull()
    expect((await fetch(`${baseUrl}/mutate`, {
      method: 'POST',
      headers: { cookie: `${cookie}`, origin: 'https://evil.onlyservice.io' },
    })).status).toBe(403)
    expect((await fetch(`${baseUrl}/mutate`, {
      method: 'POST',
      headers: { cookie: `${cookie}` },
    })).status).toBe(403)
  })

  it('authenticates each WebSocket upgrade and closes every old upgraded socket before rotation returns', async () => {
    const { baseUrl, state, gateway, upstreamOrigin } = await fixture()
    const cookie = await issueSession(baseUrl, state.accessToken())
    await expectRejectedUpgrade(new WebSocket(`${baseUrl.replace('http:', 'ws:')}/api/events.mux`, {
      headers: { cookie }, origin: 'https://evil.onlyservice.io',
    }), 403)
    await expectRejectedUpgrade(new WebSocket(`${baseUrl.replace('http:', 'ws:')}/api/events.mux`, { headers: { cookie } }), 403)
    expect(webSocketRequests).toHaveLength(0)
    await expectRejectedUpgrade(new WebSocket(`${baseUrl.replace('http:', 'ws:')}/api/settings.describe`, {
      headers: { cookie }, origin: 'https://zsh.onlyservice.io',
    }), 403)
    const socket = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/api/events.mux`, { headers: { cookie }, origin: 'https://zsh.onlyservice.io' })
    await once(socket, 'open')
    expect(webSocketRequests.at(-1)).toEqual({ origin: upstreamOrigin, host: new URL(upstreamOrigin).host, cookie: '' })
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

  it('redeems a Host launch once and gives only its expiring owner grant the configuration plane', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-remote-agent-ipc-'))
    roots.push(root)
    const socketPath = join(root, 'agent.sock')
    let redemptions = 0
    const agent = createNetServer(socket => {
      socket.setEncoding('utf8')
      socket.once('data', source => {
		const request = JSON.parse(source.toString()) as { version?: unknown; operation?: unknown; payload?: { ticket?: unknown } }
        redemptions++
        if (redemptions === 1 && request.version === '1.0' && request.operation === 'launch.redeem' && request.payload?.ticket === 't'.repeat(43)) {
          socket.end(`${JSON.stringify({ version: '1.0', ok: true, payload: { session_grant: 'g'.repeat(43), roles: ['owner'] } })}\n`)
        } else {
          socket.end(`${JSON.stringify({ version: '1.0', ok: false, error: 'unauthorized' })}\n`)
        }
      })
    })
    agentServers.push(agent)
    await new Promise<void>((resolve, reject) => { agent.once('error', reject); agent.listen(socketPath, resolve) })
    let now = 1_000
    const { baseUrl, state, upstreamOrigin } = await fixture(socketPath, { now: () => now, hostSessionTtlMs: 60_000 })

    const bootstrap = await fetch(`${baseUrl}/`)
    expect(await bootstrap.text()).toContain('dsh-host-launch')
    const launched = await fetch(`${baseUrl}/__dsh_remote/session`, {
      method: 'POST',
      headers: { origin: 'https://zsh.onlyservice.io', 'content-type': 'application/json' },
      body: JSON.stringify({ launchTicket: 't'.repeat(43) }),
    })
    expect(launched.status).toBe(204)
    const cookie = launched.headers.getSetCookie()[0]?.split(';', 1)[0]
    expect(cookie).toBe(`__Host-dsh_remote_host=${'g'.repeat(43)}`)
    expect(launched.headers.getSetCookie()).toEqual(expect.arrayContaining([
      expect.stringMatching(/^__Host-dsh_remote_owner_ui=1; Path=\/; Secure; SameSite=Strict; Max-Age=60$/u),
    ]))
    if (cookie === undefined) throw new Error('Expected Host session cookie.')
    const privateState = await state.rotate()
    expect(privateState.sessionVersion).toBe(2)
    const proxied = await fetch(`${baseUrl}/host-session`, { headers: { cookie: `${cookie}; __Host-dsh_remote_owner_ui=1; dsh=preserved` } })
    expect(proxied.status).toBe(200)
    expect((await proxied.json()).cookie).toBe('dsh=preserved')
    for (const method of PRIVILEGED_METHODS) {
      const allowed = await fetch(`${baseUrl}/api/${method}`, {
        method: 'POST', headers: { cookie, origin: 'https://zsh.onlyservice.io', 'x-dsh-remote-owner': 'ignored' },
      })
      expect(allowed.status, method).toBe(200)
      expect(await allowed.json()).toMatchObject({ cookie: '', host: new URL(upstreamOrigin).host, origin: upstreamOrigin, ownerMarker: null })
    }
    for (const method of NON_CONFIGURATION_LOOPBACK_METHODS) {
      expect((await fetch(`${baseUrl}/api/${method}`, {
        method: 'POST', headers: { cookie, origin: 'https://zsh.onlyservice.io' },
      })).status, method).toBe(403)
    }
    expect((await fetch(`${baseUrl}/reload`, { headers: { cookie } })).status).toBe(200)
    expect((await fetch(`${baseUrl}/reload`, { headers: { cookie } })).status).toBe(200)
    await expectRejectedUpgrade(new WebSocket(`${baseUrl.replace('http:', 'ws:')}/api/agentPreset.read`, {
      headers: { cookie }, origin: 'https://zsh.onlyservice.io',
    }), 403)
    const firstSocket = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/api/events.host`, { headers: { cookie }, origin: 'https://zsh.onlyservice.io' })
    await once(firstSocket, 'open')
    firstSocket.close()
    await once(firstSocket, 'close')
    const reconnect = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/api/events.host`, { headers: { cookie }, origin: 'https://zsh.onlyservice.io' })
    await once(reconnect, 'open')
    reconnect.close()
    await once(reconnect, 'close')
    const forcedBootstrap = await fetch(`${baseUrl}/__dsh_remote/launch`, { headers: { cookie } })
    expect(forcedBootstrap.status).toBe(200)
    expect(await forcedBootstrap.text()).toContain('dsh-host-launch')
    expect((await fetch(`${baseUrl}/__dsh_remote/launch`, { method: 'POST', headers: { cookie } })).status).toBe(405)

    const replay = await fetch(`${baseUrl}/__dsh_remote/session`, {
      method: 'POST',
      headers: { origin: 'https://zsh.onlyservice.io', 'content-type': 'application/json' },
      body: JSON.stringify({ launchTicket: 't'.repeat(43) }),
    })
    expect(replay.status).toBe(403)
    expect((await fetch(`${baseUrl}/malformed`, { headers: { cookie: '__Host-dsh_remote_host=not-a-grant' } })).status).toBe(401)
    now += 60_001
    expect((await fetch(`${baseUrl}/expired`, { headers: { cookie } })).status).toBe(401)
  })

  it('keeps multiple bounded owner grants independent when fresh Host launches succeed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-remote-agent-ipc-'))
    roots.push(root)
    const socketPath = join(root, 'agent.sock')
    let redemption = 0
    const grants = ['g'.repeat(43), 'h'.repeat(43)]
    const agent = createNetServer(socket => {
      socket.setEncoding('utf8')
      socket.once('data', () => {
        const grant = grants[redemption++]
        socket.end(grant === undefined
          ? `${JSON.stringify({ version: '1.0', ok: false, error: 'unauthorized' })}\n`
          : `${JSON.stringify({ version: '1.0', ok: true, payload: { session_grant: grant, roles: ['owner'] } })}\n`)
      })
    })
    agentServers.push(agent)
    await new Promise<void>((resolve, reject) => { agent.once('error', reject); agent.listen(socketPath, resolve) })
    const { baseUrl } = await fixture(socketPath)
    const first = await issueHostSession(baseUrl, 'a'.repeat(43))
    const second = await issueHostSession(baseUrl, 'b'.repeat(43))
    expect((await fetch(`${baseUrl}/first`, { headers: { cookie: first } })).status).toBe(200)
    expect((await fetch(`${baseUrl}/current`, { headers: { cookie: second } })).status).toBe(200)
  })

  it('accepts an unexpired Host grant after Gateway restart and private-link rotation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-remote-agent-ipc-'))
    roots.push(root)
    const socketPath = join(root, 'agent.sock')
    const grant = 'r'.repeat(43)
    const agent = createNetServer(socket => {
      socket.once('data', () => {
        socket.end(`${JSON.stringify({ version: '1.0', ok: true, payload: { session_grant: grant, roles: ['owner'] } })}\n`)
      })
    })
    agentServers.push(agent)
    await new Promise<void>((resolve, reject) => { agent.once('error', reject); agent.listen(socketPath, resolve) })
    const initial = await fixture(socketPath)
    const cookie = await issueHostSession(initial.baseUrl, 't'.repeat(43))
    await initial.gateway.close()
    gateways.splice(gateways.indexOf(initial.gateway), 1)

    const state = await RemoteStateStore.open(initial.state.filePath)
    await state.rotate()
    const restarted = new RemoteGateway({
      targetPort: Number(new URL(initial.upstreamOrigin).port),
      remoteOrigin: 'https://zsh.onlyservice.io',
      state,
      agentSocketPath: socketPath,
    })
    await restarted.listen()
    gateways.push(restarted)
    const baseUrl = `http://127.0.0.1:${restarted.port}`
    expect((await fetch(`${baseUrl}/after-restart-and-rotation`, { headers: { cookie } })).status).toBe(200)
  })

  it('revokes an active owner WebSocket at the grant deadline without another request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-remote-agent-ipc-'))
    roots.push(root)
    const socketPath = join(root, 'agent.sock')
    const agent = createNetServer(socket => {
      socket.once('data', () => {
        socket.end(`${JSON.stringify({ version: '1.0', ok: true, payload: { session_grant: 'g'.repeat(43), roles: ['owner'] } })}\n`)
      })
    })
    agentServers.push(agent)
    await new Promise<void>((resolve, reject) => { agent.once('error', reject); agent.listen(socketPath, resolve) })
    const { baseUrl } = await fixture(socketPath, { hostSessionTtlMs: 1_000 })
    const cookie = await issueHostSession(baseUrl, 't'.repeat(43))
    const socket = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/api/events.host`, {
      headers: { cookie }, origin: 'https://zsh.onlyservice.io',
    })
    await once(socket, 'open')
    await once(socket, 'close')
    expect((await fetch(`${baseUrl}/expired`, { headers: { cookie } })).status).toBe(401)
    await expectRejectedUpgrade(new WebSocket(`${baseUrl.replace('http:', 'ws:')}/api/events.host`, {
      headers: { cookie }, origin: 'https://zsh.onlyservice.io',
    }), 401)
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

async function issueHostSession(baseUrl: string, launchTicket: string): Promise<string> {
  const response = await fetch(`${baseUrl}/__dsh_remote/session`, {
    method: 'POST',
    headers: { origin: 'https://zsh.onlyservice.io', 'content-type': 'application/json' },
    body: JSON.stringify({ launchTicket }),
  })
  if (response.status !== 204) throw new Error(`Expected Host session response, got ${response.status}.`)
  const cookie = response.headers.getSetCookie()[0]?.split(';', 1)[0]
  if (cookie === undefined) throw new Error('Expected Host session cookie.')
  return cookie
}

const PRIVILEGED_METHODS = [
  'settings.describe', 'settings.openDocument', 'settings.update', 'settings.replace', 'settings.mutate',
  'credentials.describe', 'credentials.set', 'credentials.unset', 'llm.discoverModels',
] as const

const NON_CONFIGURATION_LOOPBACK_METHODS = [
  'agentPreset.read', 'agentPreset.copy', 'agentPreset.openDocument', 'agentPreset.remove',
  'host.pickDirectory', 'host.openPath',
] as const

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

function expectRejectedUpgrade(socket: WebSocket, status: number): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('unexpected-response', (_request, response) => {
      response.resume()
      response.once('end', () => { response.statusCode === status ? resolve() : reject(new Error(`Unexpected status ${response.statusCode}`)) })
    })
    socket.once('open', () => reject(new Error('Rejected WebSocket unexpectedly opened.')))
    socket.once('error', () => undefined)
  })
}
