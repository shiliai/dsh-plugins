import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { ApiErrorPayload, AgentSkillInput, VaultContextKind } from './contracts.ts'
import { VaultError } from './vault-service.ts'
import { VaultManager } from './vault-manager.ts'
import type { SkillCoordinator } from './skill-coordinator.ts'
import { AgentSkillStoreError, AgentSkillRevisionConflictError } from './skill-store.ts'
import { AgentSkillCodecError } from './skill-codec.ts'
import { AgentSkillValidationError } from './validate-skill.ts'

const API_PREFIX = '/dsh-obsidian/api'

interface WriteBody {
  path: string
  content: string
  expectedModifiedMs?: number
}

interface MoveBody {
  from: string
  to: string
}

export function registerVaultApi(webServer: WebServer, vault: VaultManager, mutationOrigin: string, skills?: SkillCoordinator): () => void {
  const authority = normalizeOrigin(mutationOrigin)
  return webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (request, response) => {
      try {
        await route(request, response, vault, authority, skills)
      } catch (error) {
        sendError(response, error)
      }
    },
  })
}

async function route(request: IncomingMessage, response: ServerResponse, vault: VaultManager, authority: string, skills?: SkillCoordinator): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://dsh.local')
  const endpoint = url.pathname.slice(API_PREFIX.length) || '/'
  if (request.method === 'GET' && endpoint === '/skills' && skills !== undefined) {
    sendJson(response, 200, { result: await skills.list() })
    return
  }
  if (request.method === 'GET' && endpoint === '/skill' && skills !== undefined) {
    sendJson(response, 200, await skills.read(requiredQuery(url, 'name')))
    return
  }
  if (request.method === 'PUT' && endpoint === '/skill' && skills !== undefined) {
    assertConfiguredOrigin(request, authority)
    const body = await readJson(request, 2 * 1024 * 1024)
    if (!isRecord(body) || !isRecord(body.skill)) {
      throw new VaultError('Invalid skill write body.', 'INVALID_BODY', 400)
    }
    const input = body.skill as Partial<AgentSkillInput>
    const expectedRevision = typeof body.expectedRevision === 'string' ? body.expectedRevision : undefined
    const previousName = typeof body.previousName === 'string' ? body.previousName : undefined
    const normalized = normalizeSkillInput(input)
    let result
    if (previousName !== undefined && expectedRevision !== undefined) {
      result = await skills.update(previousName, expectedRevision, normalized)
    } else {
      result = await skills.create(normalized)
    }
    sendJson(response, 200, { result })
    return
  }
  if (request.method === 'DELETE' && endpoint === '/skill' && skills !== undefined) {
    assertConfiguredOrigin(request, authority)
    const name = requiredQuery(url, 'name')
    const expectedRevision = requiredQuery(url, 'expectedRevision')
    sendJson(response, 200, { result: await skills.delete(name, expectedRevision) })
    return
  }
  if (request.method === 'GET' && endpoint === '/info') {
    sendJson(response, 200, { name: vault.root.split(/[\\/]/u).at(-1) ?? vault.root, root: vault.root })
    return
  }
  if (request.method === 'GET' && endpoint === '/tree') {
    sendJson(response, 200, { nodes: await vault.listTree() })
    return
  }
  if (request.method === 'GET' && endpoint === '/directories') {
    sendJson(response, 200, await vault.listDirectories(url.searchParams.get('path') ?? undefined))
    return
  }
  if (request.method === 'GET' && endpoint === '/note') {
    sendJson(response, 200, await vault.readNote(requiredQuery(url, 'path')))
    return
  }
  if (request.method === 'GET' && endpoint === '/search') {
    sendJson(response, 200, { results: await vault.searchNotes(requiredQuery(url, 'q'), optionalQuery(url, 'prefix')) })
    return
  }
  if (request.method === 'GET' && endpoint === '/tags') {
    sendJson(response, 200, { tags: await vault.listTags(optionalQuery(url, 'q')) })
    return
  }
  if (request.method === 'GET' && endpoint === '/tag') {
    sendJson(response, 200, { paths: await vault.searchNotesByTag(requiredQuery(url, 'name'), optionalBooleanQuery(url, 'descendants') ?? true) })
    return
  }
  if (request.method === 'GET' && endpoint === '/context') {
    const kind = requiredQuery(url, 'kind')
    if (!isContextKind(kind)) throw new VaultError('Context kind is not valid.', 'INVALID_QUERY', 400)
    sendJson(response, 200, await vault.resolveContext(kind, requiredQuery(url, 'value')))
    return
  }
  if (request.method === 'GET' && endpoint === '/asset') {
    const asset = await vault.openAsset(requiredQuery(url, 'path'))
    response.writeHead(200, {
      'Content-Type': asset.contentType,
      'Content-Length': asset.size,
      'Cache-Control': 'private, max-age=60',
      'X-Content-Type-Options': 'nosniff',
    })
    await new Promise<void>((resolve, reject) => {
      const stream = Readable.fromWeb(asset.handle.readableWebStream() as never)
      stream.once('error', reject)
      response.once('finish', resolve)
      stream.pipe(response)
    }).finally(async () => asset.handle.close())
    return
  }
  if (request.method === 'PUT' && endpoint === '/note') {
    assertConfiguredOrigin(request, authority)
    const body = await readJson(request, vault.maxNoteBytes + 4096)
    if (!isRecord(body) || typeof body.path !== 'string' || typeof body.content !== 'string'
      || (body.expectedModifiedMs !== undefined && (typeof body.expectedModifiedMs !== 'number' || !Number.isFinite(body.expectedModifiedMs)))) {
      throw new VaultError('Invalid note write body.', 'INVALID_BODY', 400)
    }
    sendJson(response, 200, await vault.writeNote(body.path, body.content, body.expectedModifiedMs as number | undefined))
    return
  }
  if (request.method === 'POST' && endpoint === '/vault') {
    assertConfiguredOrigin(request, authority)
    const body = await readJson(request, 8192)
    if (!isRecord(body) || typeof body.root !== 'string') {
      throw new VaultError('Invalid vault selection body.', 'INVALID_BODY', 400)
    }
    await vault.select(body.root)
    sendJson(response, 200, { name: vault.root.split(/[\\/]/u).at(-1) ?? vault.root, root: vault.root })
    return
  }
  if (request.method === 'POST' && endpoint === '/move') {
    assertConfiguredOrigin(request, authority)
    const body = await readJson(request, 8192)
    if (!isRecord(body) || typeof body.from !== 'string' || typeof body.to !== 'string') {
      throw new VaultError('Invalid move body.', 'INVALID_BODY', 400)
    }
    sendJson(response, 200, await vault.moveNote(body.from, body.to))
    return
  }
  if (request.method === 'DELETE' && endpoint === '/note') {
    assertConfiguredOrigin(request, authority)
    await vault.deleteNote(requiredQuery(url, 'path'))
    response.writeHead(204)
    response.end()
    return
  }
  throw new VaultError('API endpoint not found.', 'NOT_FOUND', 404)
}

function requiredQuery(url: URL, key: string): string {
  const value = url.searchParams.get(key)
  if (value === null) throw new VaultError(`Missing query parameter: ${key}`, 'INVALID_QUERY', 400)
  return value
}

function optionalQuery(url: URL, key: string): string | undefined {
  return url.searchParams.get(key) ?? undefined
}

function optionalBooleanQuery(url: URL, key: string): boolean | undefined {
  const value = url.searchParams.get(key)
  if (value === null) return undefined
  if (value === 'true') return true
  if (value === 'false') return false
  throw new VaultError(`Query parameter ${key} must be true or false.`, 'INVALID_QUERY', 400)
}

function isContextKind(value: string): value is VaultContextKind {
  return value === 'note' || value === 'directory' || value === 'tag' || value === 'search'
}

function assertConfiguredOrigin(request: IncomingMessage, authority: string): void {
  const origin = request.headers.origin
  if (origin === undefined) {
    throw new VaultError('Note mutations require a same-origin browser request.', 'ORIGIN_DENIED', 403)
  }
  try {
    if (normalizeOrigin(origin) === authority) return
  } catch {
    // A malformed Origin is not a valid same-origin browser request.
  }
  throw new VaultError('Note mutations require a same-origin browser request.', 'ORIGIN_DENIED', 403)
}

function normalizeOrigin(value: string): string {
  const url = new URL(value)
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('dsh-obsidian: mutationOrigin must be an HTTP(S) origin without a path.')
  }
  return url.origin
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface SkillBodyLike {
  name?: unknown
  description?: unknown
  whenToUse?: unknown
  modelInvocable?: unknown
  userInvocable?: unknown
  instructions?: unknown
}

function normalizeSkillInput(input: Partial<AgentSkillInput>): AgentSkillInput {
  const record = input as SkillBodyLike
  if (typeof record.name !== 'string' || typeof record.description !== 'string' || typeof record.instructions !== 'string') {
    throw new VaultError('Skill name, description and instructions are required.', 'INVALID_BODY', 400)
  }
  return {
    name: record.name,
    description: record.description,
    ...(typeof record.whenToUse === 'string' && record.whenToUse.trim() !== ''
      ? { whenToUse: record.whenToUse } : {}),
    modelInvocable: typeof record.modelInvocable === 'boolean' ? record.modelInvocable : true,
    userInvocable: typeof record.userInvocable === 'boolean' ? record.userInvocable : true,
    instructions: record.instructions,
  }
}

function isSkillError(error: unknown): error is Error {
  return error instanceof AgentSkillStoreError
    || error instanceof AgentSkillCodecError
    || error instanceof AgentSkillValidationError
    || error instanceof AgentSkillRevisionConflictError
}

function skillStatus(error: Error): number {
  if (error instanceof AgentSkillValidationError) return 400
  if (error instanceof Error && error.name === 'AgentSkillCollisionError') return 409
  if (error instanceof AgentSkillRevisionConflictError) return 409
  if (error instanceof AgentSkillCodecError) return 422
  return 500
}

async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  const contentType = request.headers['content-type'] ?? ''
  const mediaType = contentType.split(';', 1)[0]?.trim().toLocaleLowerCase()
  if (mediaType !== 'application/json') {
    throw new VaultError('Content-Type must be application/json.', 'INVALID_BODY', 415)
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > limit) throw new VaultError('Request body is too large.', 'BODY_TOO_LARGE', 413)
    chunks.push(bytes)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new VaultError('Request body is not valid JSON.', 'INVALID_BODY', 400)
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(body)
}

function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy(error instanceof Error ? error : undefined)
    return
  }
  let status: number
  let code: string
  let message: string
  if (error instanceof VaultError) {
    status = error.status
    code = error.code
    message = error.message
  } else if (isSkillError(error)) {
    const err = error as Error
    status = skillStatus(err)
    code = err.name
    message = err.message
  } else {
    status = 500
    code = 'INTERNAL_ERROR'
    message = error instanceof Error ? error.message : 'Unexpected vault error.'
  }
  sendJson(response, status, { error: message, code })
}
