/**
 * Shared HTTP handler for the per-plugin config-portability endpoints:
 *
 * - `GET  <apiPrefix>/config/export[?redact=1]` — envelope with this plugin's section
 * - `POST <apiPrefix>/config/import[?dryRun=1]` — apply (or preview) an envelope section
 *
 * The request/response shapes are duck-typed (no `node:http` import) so this
 * module stays bundle-safe for browser builds.
 */

import { buildEnvelope, ConfigPortabilityError, parseEnvelope } from './contracts.js'
import type { ConfigPortabilityProvider, ImportOutcome } from './provider.js'

export const CONFIG_PORTABILITY_EXPORT_ENDPOINT = '/config/export'
export const CONFIG_PORTABILITY_IMPORT_ENDPOINT = '/config/import'

const MAX_IMPORT_BYTES = 4 * 1024 * 1024

type HeaderValue = string | string[] | undefined

/** Minimal request shape (node `IncomingMessage` satisfies it structurally). */
export interface PortabilityRequestLike {
  method?: string | undefined
  headers: {
    origin?: HeaderValue
    host?: HeaderValue
    'x-forwarded-proto'?: HeaderValue
  }
}

/** Minimal response shape (node `ServerResponse` satisfies it structurally). */
export interface PortabilityResponseLike {
  writeHead(status: number, headers?: Record<string, string | number | undefined>): unknown
  end(payload?: string): unknown
}

export interface ConfigPortabilityRouteOptions {
  /** Query parameters of the current request (redact / dryRun flags). */
  query?: URLSearchParams | undefined
}

/**
 * Handle one config-portability request. Returns `false` when `subPath` is
 * not a portability endpoint so the caller's router can fall through.
 */
export async function handleConfigPortabilityRoute(
  request: PortabilityRequestLike,
  response: PortabilityResponseLike,
  subPath: string,
  provider: ConfigPortabilityProvider,
  options: ConfigPortabilityRouteOptions = {},
): Promise<boolean> {
  if (subPath === CONFIG_PORTABILITY_EXPORT_ENDPOINT) {
    await handleExport(request, response, provider, options.query)
    return true
  }
  if (subPath === CONFIG_PORTABILITY_IMPORT_ENDPOINT) {
    await handleImport(request, response, provider, options.query)
    return true
  }
  return false
}

async function handleExport(request: PortabilityRequestLike, response: PortabilityResponseLike, provider: ConfigPortabilityProvider, query: URLSearchParams | undefined): Promise<void> {
  if (request.method !== 'GET') {
    throw new ConfigPortabilityError('Config export requires GET.', 'INVALID_METHOD', 405)
  }
  const redactSecrets = query?.get('redact') === '1'
  const config = await provider.exportConfig({ redactSecrets })
  const envelope = buildEnvelope({ [provider.id]: { displayName: provider.displayName, config } })
  sendJson(response, 200, envelope)
}

async function handleImport(request: PortabilityRequestLike, response: PortabilityResponseLike, provider: ConfigPortabilityProvider, query: URLSearchParams | undefined): Promise<void> {
  if (request.method !== 'POST') {
    throw new ConfigPortabilityError('Config import requires POST.', 'INVALID_METHOD', 405)
  }
  // Browser state-changing requests must originate from this host. Native/API
  // clients commonly omit Origin, so absence remains allowed.
  const origin = firstHeader(request.headers.origin)
  if (origin !== undefined && !isSameOriginRequest(origin, request)) {
    throw new ConfigPortabilityError('Cross-origin config import is not allowed.', 'FORBIDDEN_ORIGIN', 403)
  }
  const raw = await readJsonBody(request)
  const envelope = parseEnvelope(raw)
  const section = envelope.plugins[provider.id]
  if (section === undefined) {
    throw new ConfigPortabilityError(`Config export has no section for "${provider.id}".`, 'SECTION_NOT_FOUND', 400)
  }
  const dryRun = query?.get('dryRun') === '1'
  const outcome = await provider.importConfig(section.config, { dryRun })
  sendJson(response, 200, { ok: true, dryRun, report: { pluginId: provider.id, displayName: provider.displayName, ...normalizeOutcome(outcome) } })
}

function normalizeOutcome(outcome: ImportOutcome): ImportOutcome {
  return {
    applied: Array.isArray(outcome.applied) ? outcome.applied : [],
    skipped: Array.isArray(outcome.skipped) ? outcome.skipped : [],
    warnings: Array.isArray(outcome.warnings) ? outcome.warnings : [],
  }
}

async function readJsonBody(request: PortabilityRequestLike): Promise<unknown> {
  const iterable = request as unknown as { [Symbol.asyncIterator]?: unknown }
  if (typeof iterable[Symbol.asyncIterator] !== 'function') {
    throw new ConfigPortabilityError('Request body is not readable.', 'INVALID_BODY', 400)
  }
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of request as unknown as AsyncIterable<Uint8Array | string>) {
    const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk
    size += bytes.byteLength
    if (size > MAX_IMPORT_BYTES) throw new ConfigPortabilityError('Request body is too large.', 'BODY_TOO_LARGE', 413)
    chunks.push(bytes)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf8', { fatal: false }).decode(concat(chunks)))
  } catch {
    throw new ConfigPortabilityError('Request body is not valid JSON.', 'INVALID_BODY', 400)
  }
  return parsed
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength }
  return out
}

function firstHeader(value: HeaderValue): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

/** Same-origin check mirroring the host router policy (x-forwarded-proto aware). */
function isSameOriginRequest(origin: string, request: PortabilityRequestLike): boolean {
  try {
    const parsed = new URL(origin)
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return false
    const host = firstHeader(request.headers.host)
    if (host === undefined || host === '') return false
    const forwardedProto = firstHeader(request.headers['x-forwarded-proto'])
    const protocol = typeof forwardedProto === 'string' && forwardedProto.split(',')[0] !== ''
      ? forwardedProto.split(',')[0]!.trim()
      : 'http'
    return parsed.protocol === `${protocol}:` && parsed.host === host
  } catch {
    return false
  }
}

function sendJson(response: PortabilityResponseLike, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    // TextEncoder keeps this bundle-safe for browser builds (no Buffer).
    'Content-Length': new TextEncoder().encode(body).byteLength,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(body)
}
