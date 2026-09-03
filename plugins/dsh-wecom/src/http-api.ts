import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { WecomLifecycleController, WecomStatus } from './lifecycle.ts'
import type { CliUpdateManager, CliUpdateStatus } from './cli-update.ts'

const API_PREFIX = '/dsh-wecom/api'

export function registerWecomApi(webServer: WebServer, controller: WecomLifecycleController, updates: Pick<CliUpdateManager, 'check' | 'update'>, trustedOrigin = 'http://127.0.0.1:3180'): () => void {
  return webServer.register({
    kind: 'prefix', path: API_PREFIX,
    handler: async (request, response) => {
      try {
        const endpoint = new URL(request.url ?? '/', 'http://dsh.local').pathname.slice(API_PREFIX.length) || '/status'
        if (request.method === 'GET' && endpoint === '/status') return sendJson(response, 200, controller.getStatus())
        if (request.method === 'GET' && endpoint === '/wecom-cli-update') return sendJson(response, 200, await updates.check())
        if (request.method === 'POST' && endpoint === '/restart') {
          if (!isTrustedMutationRequest(request, trustedOrigin)) return sendError(response, 403, 'ORIGIN_DENIED')
          return sendJson(response, 200, await controller.restart())
        }
        if (request.method === 'POST' && endpoint === '/wecom-cli-update') {
          if (!isTrustedMutationRequest(request, trustedOrigin)) return sendError(response, 403, 'ORIGIN_DENIED')
          return sendJson(response, 200, await updates.update())
        }
        return sendError(response, 404, 'NOT_FOUND')
      } catch {
        if (response.headersSent) response.destroy()
        else sendError(response, 500, 'INTERNAL_ERROR')
      }
    },
  })
}

function isTrustedMutationRequest(request: IncomingMessage, trustedOrigin: string): boolean {
  const fetchSite = request.headers['sec-fetch-site']
  if (fetchSite !== undefined && fetchSite !== 'same-origin') return false
  const origin = request.headers.origin
  if (origin === undefined) return false
  try {
    return normalizeOrigin(origin) === normalizeOrigin(trustedOrigin)
  } catch { return false }
}

function normalizeOrigin(value: string): string {
  const url = new URL(value)
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') throw new Error('invalid origin')
  return url.origin
}

function sendJson(response: ServerResponse, status: number, value: WecomStatus | CliUpdateStatus): void {
  const body = JSON.stringify(value)
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' })
  response.end(body)
}

function sendError(response: ServerResponse, status: number, code: string): void {
  const body = JSON.stringify({ error: code === 'ORIGIN_DENIED' ? 'Request origin denied.' : 'WeCom request failed.', code })
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' })
  response.end(body)
}
