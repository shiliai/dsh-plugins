import { createServer, type IncomingMessage as IncomingMessageLike, type Server, type ServerResponse as ServerResponseLike } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerReadingApi } from '../src/http-api.ts'
import { LocalLibrary } from '../src/library.ts'
import { ReadingStateStore } from '../src/state-store.ts'

let dir: string
let server: Server
let base: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-reading-api-'))
  server = createServer()
  const library = new LocalLibrary(dir)
  const store = await ReadingStateStore.create(dir)
  const fakeWebServer = {
    register(route: { handler: (req: IncomingMessageLike, res: ServerResponseLike) => Promise<void> }) {
      const listener = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void => {
        void route.handler(req as IncomingMessageLike, res as ServerResponseLike)
      }
      server.on('request', listener)
      return () => server.off('request', listener)
    },
  }
  registerReadingApi(fakeWebServer as never, library, store)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/dsh-reading/api`
})

afterEach(async () => {
  server.close()
  await rm(dir, { recursive: true, force: true })
})

describe('reading HTTP API', () => {
  it('imports a book, lists the library, and serves the file', async () => {
    const content = Buffer.from('%PDF-1.4 fake pdf payload for range tests')
    const response = await fetch(`${base}/import?filename=${encodeURIComponent('测试 book.pdf')}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: content,
    })
    expect(response.status).toBe(200)
    const { book } = await response.json() as { book: { id: string; format: string; title: string } }
    expect(book.format).toBe('pdf')
    expect(book.title).toBe('测试 book')

    const library = await (await fetch(`${base}/library`)).json() as { books: Array<{ id: string }> }
    expect(library.books.map(b => b.id)).toContain(book.id)

    const file = await fetch(`${base}/book/${encodeURIComponent(book.id)}/file`)
    expect(file.status).toBe(200)
    expect(file.headers.get('accept-ranges')).toBe('bytes')
    expect(Buffer.from(await file.arrayBuffer())).toEqual(content)
  })

  it('rejects unsupported import formats', async () => {
    const response = await fetch(`${base}/import?filename=book.txt`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from('hi'),
    })
    expect(response.status).toBe(415)
  })

  it('serves Range requests with 206 and correct bytes', async () => {
    const content = Buffer.from('0123456789abcdef')
    const { book } = await (await fetch(`${base}/import?filename=r.epub`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: content,
    })).json() as { book: { id: string } }

    const partial = await fetch(`${base}/book/${encodeURIComponent(book.id)}/file`, { headers: { Range: 'bytes=4-9' } })
    expect(partial.status).toBe(206)
    expect(partial.headers.get('content-range')).toBe('bytes 4-9/16')
    expect(Buffer.from(await partial.arrayBuffer()).toString()).toBe('456789')

    const suffix = await fetch(`${base}/book/${encodeURIComponent(book.id)}/file`, { headers: { Range: 'bytes=-4' } })
    expect(suffix.status).toBe(206)
    expect(Buffer.from(await suffix.arrayBuffer()).toString()).toBe('cdef')

    const openEnded = await fetch(`${base}/book/${encodeURIComponent(book.id)}/file`, { headers: { Range: 'bytes=8-' } })
    expect(openEnded.status).toBe(206)
    expect(Buffer.from(await openEnded.arrayBuffer()).toString()).toBe('89abcdef')

    const outOfRange = await fetch(`${base}/book/${encodeURIComponent(book.id)}/file`, { headers: { Range: 'bytes=99-100' } })
    expect(outOfRange.status).toBe(416)
  })

  it('persists reading progress', async () => {
    const { book } = await (await fetch(`${base}/import?filename=p.epub`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from('fake'),
    })).json() as { book: { id: string } }
    const put = await fetch(`${base}/progress/${encodeURIComponent(book.id)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locator: { type: 'epub', cfi: 'epubcfi(/6/2!/2)', chapterHref: 'a.xhtml' }, percent: 0.77 }),
    })
    expect(put.status).toBe(200)
    const got = await (await fetch(`${base}/progress/${encodeURIComponent(book.id)}`)).json() as { progress: { percent: number } }
    expect(got.progress.percent).toBe(0.77)
    const all = await (await fetch(`${base}/progress`)).json() as { progress: Record<string, unknown> }
    expect(Object.keys(all.progress)).toHaveLength(1)
  })
})
