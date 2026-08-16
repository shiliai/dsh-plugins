import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { RemoteStatus } from './contracts.ts'
import { RemoteService } from './remote-service.ts'

const API_PREFIX = '/dsh-remote/api'

export function registerRemoteApi(webServer: WebServer, service: RemoteService, allowedOrigins: readonly string[]): () => void {
  return webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (request, response) => {
      try {
        await route(request, response, service, new Set(allowedOrigins))
      } catch (error) {
        if (response.headersSent) response.destroy()
        else if (error instanceof Error && error.name === 'OriginDenied') sendError(response, 403, 'ORIGIN_DENIED')
        else sendError(response, 500, 'REMOTE_ERROR')
      }
    },
  })
}

async function route(request: IncomingMessage, response: ServerResponse, service: RemoteService, allowedOrigins: ReadonlySet<string>): Promise<void> {
  const endpoint = new URL(request.url ?? '/', 'http://dsh.local').pathname.slice(API_PREFIX.length) || '/status'
  if (request.method === 'GET' && (endpoint === '/' || endpoint === '/status')) {
    sendJson(response, 200, service.status())
    return
  }
  if (request.method === 'POST' && endpoint === '/rotate') {
    assertOrigin(request, allowedOrigins)
    sendJson(response, 200, await service.rotate())
    return
  }
  if (request.method === 'POST' && endpoint === '/reconnect') {
    assertOrigin(request, allowedOrigins)
    sendJson(response, 200, service.reconnect())
    return
  }
  sendError(response, 404, 'NOT_FOUND')
}

function assertOrigin(request: IncomingMessage, allowedOrigins: ReadonlySet<string>): void {
  const origin = request.headers.origin
  if (origin === undefined || !allowedOrigins.has(origin)) {
    const error = new Error('ORIGIN_DENIED')
    error.name = 'OriginDenied'
    throw error
  }
}

function sendJson(response: ServerResponse, status: number, value: RemoteStatus): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(body)
}

function sendError(response: ServerResponse, status: number, code: string): void {
  const body = JSON.stringify({ error: code === 'ORIGIN_DENIED' ? 'Request origin denied.' : 'Remote request failed.', code })
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(body)
}
