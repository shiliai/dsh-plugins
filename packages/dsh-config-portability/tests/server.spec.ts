import { describe, expect, it } from 'vitest'
import { buildEnvelope, ConfigPortabilityError } from '../src/contracts.ts'
import type { ConfigPortabilityProvider, ImportOutcome } from '../src/provider.ts'
import { handleConfigPortabilityRoute, type PortabilityRequestLike, type PortabilityResponseLike } from '../src/server.ts'

interface CapturedResponse {
  status?: number | undefined
  headers?: Record<string, string | number | undefined> | undefined
  body?: string | undefined
}

function makeProvider(overrides: Partial<ConfigPortabilityProvider> = {}): ConfigPortabilityProvider {
  return {
    id: 'stub',
    displayName: 'Stub',
    exportConfig: () => ({ hello: 'world' }),
    importConfig: (): ImportOutcome => ({ applied: ['all'], skipped: [], warnings: [] }),
    ...overrides,
  }
}

function makeRequest(options: { method?: string; origin?: string; host?: string; body?: string } = {}): PortabilityRequestLike & AsyncIterable<Uint8Array> {
  return {
    method: options.method ?? 'GET',
    headers: { ...(options.origin !== undefined ? { origin: options.origin } : {}), ...(options.host !== undefined ? { host: options.host } : {}) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async *[Symbol.asyncIterator]() {
      if (options.body !== undefined) yield new TextEncoder().encode(options.body)
    },
  }
}

function makeResponse(): PortabilityResponseLike & CapturedResponse {
  const response: PortabilityResponseLike & CapturedResponse = {
    writeHead(status, headers) { response.status = status; response.headers = headers; return response },
    end(payload) { response.body = payload; return response },
  }
  return response
}

describe('handleConfigPortabilityRoute', () => {
  it('falls through for unrelated paths', async () => {
    const handled = await handleConfigPortabilityRoute(makeRequest(), makeResponse(), '/library', makeProvider())
    expect(handled).toBe(false)
  })

  it('serves GET export and honors redact=1', async () => {
    const provider = makeProvider({ exportConfig: options => ({ redacted: options.redactSecrets }) })
    const response = makeResponse()
    const handled = await handleConfigPortabilityRoute(makeRequest({ method: 'GET' }), response, '/config/export', provider, { query: new URL('http://x/config/export?redact=1').searchParams })
    expect(handled).toBe(true)
    expect(response.status).toBe(200)
    const envelope = JSON.parse(response.body!) as { plugins: Record<string, { displayName: string; config: unknown }> }
    expect(envelope.plugins.stub).toEqual({ displayName: 'Stub', config: { redacted: true } })
  })

  it('rejects non-GET export and non-POST import', async () => {
    await expect(handleConfigPortabilityRoute(makeRequest({ method: 'POST' }), makeResponse(), '/config/export', makeProvider())).rejects.toMatchObject({ status: 405 })
    await expect(handleConfigPortabilityRoute(makeRequest({ method: 'GET' }), makeResponse(), '/config/import', makeProvider())).rejects.toMatchObject({ status: 405 })
  })

  it('imports an envelope section and reports the outcome', async () => {
    const seen: Array<{ config: unknown; dryRun: boolean }> = []
    const provider = makeProvider({ importConfig: (config, options) => { seen.push({ config, dryRun: options.dryRun }); return { applied: ['wallabag'], skipped: ['opds'], warnings: ['w'] } } })
    const envelope = buildEnvelope({ stub: { displayName: 'Stub', config: { a: 1 } } })
    const response = makeResponse()
    await handleConfigPortabilityRoute(
      makeRequest({ method: 'POST', host: '127.0.0.1:5280', origin: 'http://127.0.0.1:5280', body: JSON.stringify(envelope) }),
      response, '/config/import', provider, { query: new URL('http://x/config/import?dryRun=1').searchParams },
    )
    expect(seen).toEqual([{ config: { a: 1 }, dryRun: true }])
    expect(response.status).toBe(200)
    const payload = JSON.parse(response.body!) as { ok: boolean; dryRun: boolean; report: { pluginId: string; applied: string[]; skipped: string[]; warnings: string[] } }
    expect(payload.ok).toBe(true)
    expect(payload.dryRun).toBe(true)
    expect(payload.report).toEqual({ pluginId: 'stub', displayName: 'Stub', applied: ['wallabag'], skipped: ['opds'], warnings: ['w'] })
  })

  it('rejects cross-origin POST imports', async () => {
    const envelope = buildEnvelope({ stub: { displayName: 'Stub', config: {} } })
    await expect(handleConfigPortabilityRoute(
      makeRequest({ method: 'POST', host: '127.0.0.1:5280', origin: 'http://evil.example', body: JSON.stringify(envelope) }),
      makeResponse(), '/config/import', makeProvider(),
    )).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN_ORIGIN' })
  })

  it('rejects invalid bodies and missing sections', async () => {
    await expect(handleConfigPortabilityRoute(
      makeRequest({ method: 'POST', host: 'h', body: 'not json' }), makeResponse(), '/config/import', makeProvider(),
    )).rejects.toMatchObject({ status: 400 })
    const envelope = buildEnvelope({ other: { displayName: 'Other', config: {} } })
    await expect(handleConfigPortabilityRoute(
      makeRequest({ method: 'POST', host: 'h', body: JSON.stringify(envelope) }), makeResponse(), '/config/import', makeProvider(),
    )).rejects.toMatchObject({ status: 400, code: 'SECTION_NOT_FOUND' })
  })

  it('surfaces ConfigPortabilityError with status and code', () => {
    const error = new ConfigPortabilityError('boom', 'BOOM', 418)
    expect(error.status).toBe(418)
    expect(error.code).toBe('BOOM')
  })
})
