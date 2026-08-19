import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { createHash, randomBytes } from 'node:crypto'
import httpProxy from 'http-proxy'
import { redeemLaunch } from './agent-ipc.ts'
import { REMOTE_COOKIE, RemoteStateStore } from './state-store.ts'

const SESSION_PATH = '/__dsh_remote/session'
const HOST_COOKIE = '__Host-dsh_remote_host'
const KEEP_ALIVE_TIMEOUT_MS = 60_000
const SECURITY_HEADERS: OutgoingHttpHeaders = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
}

export interface RemoteGatewayOptions {
  targetPort: number
  remoteOrigin: string
  state: RemoteStateStore
  host?: '127.0.0.1'
  port?: number
  agentSocketPath?: string
}

export class RemoteGateway {
  private readonly server: Server
  private readonly proxy = httpProxy.createProxyServer({ changeOrigin: true, ws: true, xfwd: false })
  private readonly upgradedSockets = new Map<number, Set<Duplex>>()
  private readonly connections = new Set<Socket>()
  private readonly hostSessions = new Map<string, number>()
  private boundPort: number | undefined

  constructor(private readonly options: RemoteGatewayOptions) {
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        if (response.headersSent) response.destroy()
        else send(response, 500, 'Remote service unavailable.')
      })
    })
    this.server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS
    this.server.headersTimeout = KEEP_ALIVE_TIMEOUT_MS + 5_000
    this.server.on('connection', socket => {
      this.connections.add(socket)
      socket.once('close', () => { this.connections.delete(socket) })
    })
    this.server.on('upgrade', (request, socket, head) => { this.handleUpgrade(request, socket, head) })
    this.proxy.on('proxyRes', proxyResponse => {
      Object.assign(proxyResponse.headers, SECURITY_HEADERS)
    })
    this.proxy.on('error', (_error, _request, response) => {
      if (isServerResponse(response)) {
        if (response.headersSent) response.destroy()
        else send(response, 502, 'Remote service unavailable.')
      } else {
        response.destroy()
      }
    })
  }

  get port(): number {
    if (this.boundPort === undefined) throw new Error('Remote gateway is not listening.')
    return this.boundPort
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => { this.server.off('listening', onListening); reject(error) }
      const onListening = (): void => { this.server.off('error', onError); resolve() }
      this.server.once('error', onError)
      this.server.once('listening', onListening)
      this.server.listen(this.options.port ?? 0, this.options.host ?? '127.0.0.1')
    })
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error('Remote gateway did not bind a TCP port.')
    this.boundPort = address.port
  }

  async close(): Promise<void> {
    for (const sockets of this.upgradedSockets.values()) {
      for (const socket of sockets) socket.destroy()
    }
    this.upgradedSockets.clear()
    for (const connection of this.connections) connection.destroy()
    this.connections.clear()
    this.proxy.close()
    await new Promise<void>((resolve, reject) => {
      this.server.close(error => error === undefined ? resolve() : reject(error))
    })
  }

  closeSessionsBefore(version: number): void {
    for (const [socketVersion, sockets] of this.upgradedSockets) {
      if (socketVersion >= version) continue
      this.upgradedSockets.delete(socketVersion)
      for (const socket of sockets) socket.destroy()
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? '/', 'http://gateway.local').pathname
    if (path === SESSION_PATH) {
      await this.handleSession(request, response)
      return
    }
    const sessionVersion = this.authenticate(request.headers.cookie)
    if (path === '/' && request.method === 'GET' && sessionVersion === null) {
      sendBootstrap(response)
      return
    }
    if (sessionVersion === null) {
      send(response, 401, 'Access denied.')
      return
    }
    if (!this.allowedHttpOrigin(request)) {
      send(response, 403, 'Access denied.')
      return
    }
    this.proxy.web(request, response, {
      target: this.target(),
      headers: upstreamHeaders(request.headers, this.target()),
    })
  }

  private async handleSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST') {
      send(response, 405, 'Method not allowed.', { Allow: 'POST' })
      return
    }
    if (request.headers.origin !== this.options.remoteOrigin) {
      send(response, 403, 'Access denied.')
      return
    }
    if (mediaType(request.headers['content-type']) !== 'application/json') {
      send(response, 415, 'Invalid session request.')
      return
    }
    const body = await readJson(request, 1024)
    let cookie: string
    let maxAge: number
    if (isTokenRequest(body) && this.options.state.verifyBearer(body.token)) {
      cookie = `${REMOTE_COOKIE}=${this.options.state.sessionCookie()}`
      maxAge = 31_536_000
    } else if (isLaunchRequest(body) && this.options.agentSocketPath !== undefined) {
      try {
        const result = await redeemLaunch(this.options.agentSocketPath, body.launchTicket)
        this.hostSessions.set(digest(result.sessionGrant), Date.now() + 8 * 60 * 60 * 1000)
        cookie = `${HOST_COOKIE}=${result.sessionGrant}`
        maxAge = 28_800
      } catch {
        send(response, 403, 'Access denied.')
        return
      }
    } else {
      send(response, 403, 'Access denied.')
      return
    }
    response.writeHead(204, {
      ...SECURITY_HEADERS,
      'Set-Cookie': `${cookie}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`,
    })
    response.end()
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const version = this.authenticate(request.headers.cookie)
    if (version === null || request.headers.origin !== this.options.remoteOrigin) {
      rejectUpgrade(socket, version === null ? 401 : 403)
      return
    }
    const sockets = this.upgradedSockets.get(version) ?? new Set<Duplex>()
    sockets.add(socket)
    this.upgradedSockets.set(version, sockets)
    const release = (): void => {
      sockets.delete(socket)
      if (sockets.size === 0) this.upgradedSockets.delete(version)
    }
    socket.once('close', release)
    try {
      this.proxy.ws(request, socket, head, {
        target: this.target(),
        headers: upstreamHeaders(request.headers, this.target()),
      })
    } catch {
      release()
      socket.destroy()
    }
  }

  private authenticate(header: string | undefined): number | null {
    const privateVersion = this.options.state.authenticateCookie(header)
    if (privateVersion !== null) return privateVersion
    const grant = cookieValue(header, HOST_COOKIE)
    if (grant === undefined || !/^[A-Za-z0-9_-]{43}$/u.test(grant)) return null
    const key = digest(grant)
    const expiry = this.hostSessions.get(key)
    if (expiry === undefined || expiry <= Date.now()) {
      this.hostSessions.delete(key)
      return null
    }
    return Number.MAX_SAFE_INTEGER
  }

  private target(): string {
    return `http://127.0.0.1:${this.options.targetPort}`
  }

  private allowedHttpOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin
    if (origin !== undefined) return origin === this.options.remoteOrigin
    return ['GET', 'HEAD', 'OPTIONS'].includes(request.method ?? '')
  }
}

function sendBootstrap(response: ServerResponse): void {
  const nonce = randomBytes(16).toString('base64url')
  const body = `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Connecting</title><main id="status">Connecting...</main><script nonce="${nonce}">(()=>{const privateMatch=/^#\\/access\\/([A-Za-z0-9_-]{43})$/.exec(location.hash);const hostMatch=/^#dsh-host-launch=([A-Za-z0-9_-]{43})$/.exec(location.hash);const status=document.getElementById('status');const body=privateMatch?{token:privateMatch[1]}:hostMatch?{launchTicket:hostMatch[1]}:null;if(!body){status.textContent='Invalid link.';return}fetch('${SESSION_PATH}',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(response=>{if(!response.ok)throw new Error('denied');history.replaceState(null,'','/');location.replace('/')}).catch(()=>{status.textContent='Invalid link.'})})()</script>`
  send(response, 200, body, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` })
}

function send(response: ServerResponse, status: number, body: string, headers: OutgoingHttpHeaders = {}): void {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  })
  response.end(body)
}

function rejectUpgrade(socket: Duplex, status: number): void {
  socket.end(`HTTP/1.1 ${status} Unauthorized\r\nConnection: close\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\n\r\n`)
}

function withoutRemoteCookie(headers: IncomingMessage['headers']): Record<string, string> {
  const normalized = Object.fromEntries(Object.entries(headers)
    .filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
    .map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value]))
  const cookie = normalized.cookie
  if (cookie === undefined) return normalized
  const kept = cookie.split(';').filter(part => !part.trim().startsWith(`${REMOTE_COOKIE}=`) && !part.trim().startsWith(`${HOST_COOKIE}=`)).join(';').trim()
  if (kept === '') delete normalized.cookie
  else normalized.cookie = kept
  return normalized
}

function upstreamHeaders(headers: IncomingMessage['headers'], target: string): Record<string, string> {
  const normalized = withoutRemoteCookie(headers)
  if (normalized.origin !== undefined) normalized.origin = target
  return normalized
}

async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += bytes.length
      if (size > limit) return null
      chunks.push(bytes)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    return null
  }
}

function mediaType(value: string | undefined): string | undefined {
  return value?.split(';', 1)[0]?.trim().toLowerCase()
}

function isTokenRequest(value: unknown): value is { token: string } {
  return exactObject(value, ['token']) && typeof value.token === 'string'
}

function isLaunchRequest(value: unknown): value is { launchTicket: string } {
  return exactObject(value, ['launchTicket']) && typeof value.launchTicket === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value.launchTicket)
}

function exactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return undefined
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url')
}

function isServerResponse(value: ServerResponse | Duplex): value is ServerResponse {
  return 'writeHead' in value
}
