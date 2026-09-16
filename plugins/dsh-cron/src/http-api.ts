/**
 * Plugin HTTP surface under `/dsh-cron/api`. GETs serve state/catalog JSON;
 * every mutation requires an `application/json` body plus a same-origin
 * fetch-metadata posture, so cross-site "simple requests" (forms, no-cors
 * fetch) cannot touch the scheduler. Registered only when a webServer service
 * exists; headless profiles mount without it.
 * @module @dsh-plugins/dsh-cron/http-api
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { buildCatalog } from './catalog.ts'
import type { CronController } from './controller.ts'
import type { Context } from '@deepseek-ai/cordis'

export const API_PREFIX = '/dsh-cron/api'
const MAX_BODY_BYTES = 1_000_000

export function registerCronApi(ctx: Context, webServer: WebServer, controller: CronController): () => void {
  return webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (request, response) => {
      const endpoint = new URL(request.url ?? '/', 'http://dsh.local').pathname.slice(API_PREFIX.length) || '/state'
      try {
        await handle(ctx, controller, request, response, endpoint)
      } catch (error) {
        sendError(response, 500, 'INTERNAL', error instanceof Error ? error.message : String(error))
      }
    },
  })
}

async function handle(ctx: Context, controller: CronController, request: IncomingMessage, response: ServerResponse, endpoint: string): Promise<void> {
  const method = request.method ?? 'GET'
  if (method === 'GET' && endpoint === '/state') {
    return sendJson(response, 200, controller.state())
  }
  if (method === 'GET' && endpoint === '/catalog') {
    return sendJson(response, 200, await buildCatalog(ctx))
  }
  if (method === 'GET' && /^\/runs\/[^/]+$/.test(endpoint)) {
    const jobId = decodeURIComponent(endpoint.slice('/runs/'.length))
    const result = controller.runHistory(jobId)
    return result.ok ? sendJson(response, 200, { runs: result.runs }) : sendError(response, 404, 'NOT_FOUND', result.error ?? 'not found')
  }

  if (!isTrustedMutation(request)) {
    return sendError(response, 403, 'MUTATION_DENIED', '写接口要求 application/json 且同源。')
  }

  const jobMatch = /^\/jobs\/([^/]+)(?:\/([^/]+))?$/.exec(endpoint)
  if (method === 'POST' && endpoint === '/jobs') {
    const body = await readJson(request)
    if (body === undefined) return sendError(response, 400, 'BAD_JSON', '请求体需为合法 JSON')
    const result = await controller.createManualJob(body as Record<string, unknown>)
    return result.ok ? sendJson(response, 200, result.job) : sendError(response, 400, 'INVALID_JOB', result.error ?? 'invalid job', result.field)
  }
  if (method === 'PUT' && jobMatch !== null && jobMatch[2] === undefined) {
    const body = await readJson(request)
    if (body === undefined) return sendError(response, 400, 'BAD_JSON', '请求体需为合法 JSON')
    const result = await controller.updateManualJob(decodeURIComponent(jobMatch[1]!), body as Record<string, unknown>)
    return result.ok ? sendJson(response, 200, result.job) : sendError(response, 400, 'INVALID_JOB', result.error ?? 'invalid job', result.field)
  }
  if (method === 'POST' && jobMatch !== null) {
    const id = decodeURIComponent(jobMatch[1]!)
    const action = jobMatch[2]
    if (action === 'enable') return finish(response, await controller.setEnabled(id, true))
    if (action === 'disable') return finish(response, await controller.setEnabled(id, false))
    if (action === 'run') return finish(response, await controller.runNow(id))
    if (action === 'stop') return finish(response, await controller.stopRun(id))
    return sendError(response, 404, 'NOT_FOUND', `未知操作 ${action ?? ''}`)
  }
  if (method === 'DELETE' && jobMatch !== null && jobMatch[2] === undefined) {
    const result = await controller.removeJob(decodeURIComponent(jobMatch[1]!))
    return result.ok ? sendJson(response, 200, { ok: true }) : sendError(response, 400, 'DELETE_DENIED', result.error ?? 'delete failed')
  }
  sendError(response, 404, 'NOT_FOUND', `未知端点 ${method} ${endpoint}`)
}

function finish(response: ServerResponse, result: { ok: boolean; job?: unknown; error?: string | undefined }): void {
  if (result.ok) return sendJson(response, 200, result.job ?? { ok: true })
  sendError(response, 400, 'OP_FAILED', result.error ?? 'operation failed')
}

/**
 * The cross-site fence: browsers attach `sec-fetch-site` on every fetch, and a
 * cross-site simple request cannot carry `application/json`. Non-browser
 * clients (curl, scripts) pass with a JSON content-type.
 */
export function isTrustedMutation(request: IncomingMessage): boolean {
  if (request.method === 'GET' || request.method === 'HEAD') return false
  const fetchSite = request.headers['sec-fetch-site']
  if (fetchSite !== undefined && fetchSite !== 'same-origin') return false
  const contentType = request.headers['content-type']
  return typeof contentType === 'string' && contentType.toLowerCase().includes('application/json')
}

function readJson(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let bytes = 0
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength
      if (bytes > MAX_BODY_BYTES) {
        resolve(undefined)
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
        resolve(parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined)
      } catch {
        resolve(undefined)
      }
    })
    request.on('error', () => resolve(undefined))
  })
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
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

function sendError(response: ServerResponse, status: number, code: string, message: string, field?: string | undefined): void {
  const body = JSON.stringify({ error: message ?? code, code, ...(field !== undefined ? { field } : {}) })
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(body)
}
