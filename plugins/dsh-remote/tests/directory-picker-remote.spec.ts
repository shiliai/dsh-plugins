import { Context } from '@deepseek-ai/cordis'
import BrowseDirectoryPicker from '@deepseek-ai/dsh-host-directory-picker-browse'
import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteGateway } from '../src/gateway.ts'
import { RemoteStateStore } from '../src/state-store.ts'

const roots: string[] = []
const servers: Server[] = []
const gateways: RemoteGateway[] = []

afterEach(async () => {
  await Promise.all(gateways.splice(0).map(gateway => gateway.close()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolveClose, reject) => {
    server.close(error => error === undefined ? resolveClose() : reject(error))
  })))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('remote directory picker overlay', () => {
  it('proxies an authenticated remote project-open request to the browse capability without a host-native side effect', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-remote-directory-picker-'))
    roots.push(root)
    await mkdir(join(root, 'project'))
    const picker = new BrowseDirectoryPicker(new Context(), { maxEntries: 10 })
    const nativeSideEffect = vi.fn()
    const host = createServer((request, response) => {
      if (request.url !== '/open-project') return response.writeHead(404).end()
      const capability = picker.capability()
      if (capability.kind !== 'browse') return nativeSideEffect()
      void capability.list(root).then(listing => {
        const body = JSON.stringify(listing)
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
        response.end(body)
      })
    })
    servers.push(host)
    await listen(host)
    const address = host.address()
    if (address === null || typeof address === 'string') throw new Error('Host fixture did not bind a TCP port.')
    const state = await RemoteStateStore.open(join(root, 'state.json'))
    const origin = 'https://x570.dsh.onlyservice.io'
    const gateway = new RemoteGateway({ targetPort: address.port, remoteOrigin: origin, state })
    gateways.push(gateway)
    await gateway.listen()
    const baseUrl = `http://127.0.0.1:${gateway.port}`
    const session = await fetch(`${baseUrl}/__dsh_remote/session`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token: state.accessToken() }),
    })
    expect(session.status).toBe(204)
    const cookie = session.headers.getSetCookie()[0]?.split(';', 1)[0]
    expect(cookie).toBeDefined()
    if (cookie === undefined) throw new Error('Expected a remote session cookie.')
    const opened = await fetch(`${baseUrl}/open-project`, { headers: { cookie, origin } })
    expect(opened.status).toBe(200)
    expect(await opened.json()).toEqual(expect.objectContaining({ path: resolve(root), entries: expect.arrayContaining([expect.objectContaining({ name: 'project' })]) }))
    expect(nativeSideEffect).not.toHaveBeenCalled()
  })

  it('replaces the built-in row instead of registering a competing picker', async () => {
    const patch = await readFile(resolve(import.meta.dirname, '../cordis.patch.yml'), 'utf8')
    expect((patch.match(/^\s*- id: directory-picker$/gm) ?? [])).toHaveLength(1)
    expect((patch.match(/^\s*- id: directory-picker-surface$/gm) ?? [])).toHaveLength(1)
    expect(patch).toContain("name: '@deepseek-ai/dsh-host-directory-picker-browse'")
    expect(patch).toContain("name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'")
  })
})

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
}
