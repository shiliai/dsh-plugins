import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inject, name } from '../src/index.ts'

describe('DSH rc.6 package contract', () => {
  it('pins the supported host and client peer surface to exactly rc.6', async () => {
    const source = await readFile(resolve(import.meta.dirname, '../package.json'), 'utf8')
    const patch = await readFile(resolve(import.meta.dirname, '../cordis.patch.yml'), 'utf8')
    const manifest = JSON.parse(source) as { peerDependencies: Record<string, string>; devDependencies: Record<string, string>; files: string[]; bin: Record<string, string>; scripts: Record<string, string> }
    for (const dependency of [
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-ui-layout',
      '@deepseek-ai/dsh-client-ui-sidebar',
      '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-host-webserver',
    ]) {
      expect(manifest.peerDependencies[dependency]).toBe('0.1.0-rc.6')
    }
    expect(manifest.devDependencies['@deepseek-ai/dsh']).toBe('0.1.0-rc.6')
    expect(manifest.bin['dsh-remote-edge']).toBe('./scripts/dsh-remote-edge.mjs')
    expect(manifest.files).toEqual(expect.arrayContaining(['scripts/', 'templates/', 'docs/operations/vps-edge.md']))
    expect(manifest.scripts['e2e:rc6']).toBe('node tests/e2e/run-rc6-fixture-e2e.mjs')
    expect(patch).toContain("remoteSocketPath: '/home/chriswang/.local/share/dsh-remote/tunnel.sock'")
    expect(patch).toContain('DSH_REMOTE_STATE_FILE')
    expect(name).toBe('dsh-remote')
    expect(inject).toEqual(['webServer'])
  })
})
