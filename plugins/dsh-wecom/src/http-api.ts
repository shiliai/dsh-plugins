import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { WecomLifecycleController, WecomStatus } from './lifecycle.ts'

const API_PREFIX = '/dsh-wecom/api'

export function registerWecomApi(webServer: WebServer, controller: WecomLifecycleController): () => void {
  return webServer.register({
    kind: 'prefix', path: API_PREFIX,
    handler: async (request, response) => {
      try {
        const endpoint = new URL(request.url ?? '/', 'http://dsh.local').pathname.slice(API_PREFIX.length) || '/status'
        if (request.method === 'GET' && endpoint === '/status') return sendJson(response, 200, controller.getStatus())
        if (request.method === 'POST' && endpoint === '/restart') {
          if (!isSameOrigin(request)) return sendError(response, 403, 'ORIGIN_DENIED')
          return sendJson(response, 200, await controller.restart())
        }
        return sendError(response, 404, 'NOT_FOUND')
      } catch {
        if (response.headersSent) response.destroy()
        else sendError(response, 500, 'INTERNAL_ERROR')
      }
    },
  })
}

function isSameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  const host = request.headers.host
  if (origin === undefined || host === undefined) return false
  try {
    const url = new URL(origin)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.host === host
  } catch { return false }
}

function sendJson(response: ServerResponse, status: number, value: WecomStatus): void {
  const body = JSON.stringify(value)
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' })
  response.end(body)
}

function sendError(response: ServerResponse, status: number, code: string): void {
  const body = JSON.stringify({ error: code === 'ORIGIN_DENIED' ? 'Request origin denied.' : 'WeCom request failed.', code })
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' })
  response.end(body)
}
