import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inject, name } from '../src/index.ts'

describe('DSH rc.6 package contract', () => {
  it('pins the supported host and client peer surface to exactly rc.6', async () => {
    const source = await readFile(resolve(import.meta.dirname, '../package.json'), 'utf8')
    const patch = await readFile(resolve(import.meta.dirname, '../cordis.patch.yml'), 'utf8')
    const manifest = JSON.parse(source) as { peerDependencies: Record<string, string>; peerDependenciesMeta: Record<string, { optional?: boolean }>; devDependencies: Record<string, string>; files: string[]; bin: Record<string, string>; scripts: Record<string, string> }
    for (const dependency of [
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-ui-layout',
      '@deepseek-ai/dsh-client-ui-sidebar',
      '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-client-ui-directory-picker-browse',
      '@deepseek-ai/dsh-host-webserver',
      '@deepseek-ai/dsh-host-directory-picker-browse',
    ]) {
      expect(manifest.peerDependencies[dependency]).toBe('0.1.0-rc.6')
    }
    expect(manifest.peerDependenciesMeta['@deepseek-ai/dsh-host-directory-picker-browse']?.optional).toBe(true)
    expect(manifest.peerDependenciesMeta['@deepseek-ai/dsh-client-ui-directory-picker-browse']?.optional).toBe(true)
    expect(manifest.devDependencies['@deepseek-ai/dsh']).toBe('0.1.0-rc.6')
    expect(manifest.bin['dsh-remote-edge']).toBe('./scripts/dsh-remote-edge.mjs')
    expect(manifest.bin['dsh-remote-install-node']).toBe('./scripts/install-dsh-remote-instance.sh')
    expect(manifest.files).toEqual(expect.arrayContaining(['scripts/', 'templates/', 'docs/operations/vps-edge.md']))
    expect(manifest.scripts['e2e:rc6']).toBe('node tests/e2e/run-rc6-fixture-e2e.mjs')
    expect(patch).toContain("remoteSocketPath: '/home/chriswang/.local/share/dsh-remote/tunnel.sock'")
    expect(patch).toContain('DSH_REMOTE_INSTANCE_ID')
    expect(patch).toContain('DSH_REMOTE_BASE_DOMAIN')
    expect(await readFile(resolve(import.meta.dirname, '../scripts/remote-hub.py'), 'utf8')).toContain('instance-add')
    const wrapper = await readFile(resolve(import.meta.dirname, '../scripts/dsh-remote-edge.mjs'), 'utf8')
    expect(wrapper).toContain("const interactiveAdmin = command === 'hub'")
    expect(wrapper).toContain("interactiveAdmin ? ['-tt'] : []")
    expect(await readFile(resolve(import.meta.dirname, '../scripts/install-dsh-node.sh'), 'utf8')).toContain('DSH_HOME_TARGET')
    expect(await readFile(resolve(import.meta.dirname, '../scripts/install-dsh-remote-instance.sh'), 'utf8')).toContain('DSH_REMOTE_INSTANCE_ID')
    expect(await readFile(resolve(import.meta.dirname, '../scripts/install-dsh-remote-instance.sh'), 'utf8')).toContain('EnvironmentFile=-$environment_file')
    expect(await readFile(resolve(import.meta.dirname, '../src/remote-service.ts'), 'utf8')).toContain('DSH_REMOTE_INITIAL_TOKEN')
    expect(await readFile(resolve(import.meta.dirname, '../scripts/install-dsh-remote-instance.sh'), 'utf8')).toContain('--enable-linger')
    const runbook = await readFile(resolve(import.meta.dirname, '../docs/operations/vps-edge.md'), 'utf8')
    for (const command of [
      'dsh-remote-edge hub preflight',
      'dsh-remote-edge hub apply',
      'dsh-remote-edge hub status',
      'dsh-remote-edge hub acknowledge-alert',
      'dsh-remote-edge hub renewal-check',
      'dsh-remote-edge instance rollback --receipt <transaction-id>',
      'dsh-remote-edge hub rollback --receipt <deployment-receipt-id>',
      'dsh-remote-install-node <package.tgz> <instance-id>',
    ]) expect(runbook).toContain(command)
    expect(runbook).toContain('03:23')
    expect(runbook).toContain('/etc/logrotate.d/dsh-remote-hub')
    expect(runbook).toContain('protected-route')
    expect(runbook).toContain('`401`')
    expect(patch).toContain('DSH_REMOTE_STATE_FILE')
    expect((patch.match(/^\s*- id: directory-picker$/gm) ?? [])).toHaveLength(1)
    expect((patch.match(/^\s*- id: directory-picker-surface$/gm) ?? [])).toHaveLength(1)
    expect((patch.match(/name: '@deepseek-ai\/dsh-host-directory-picker-browse'/g) ?? [])).toHaveLength(1)
    expect((patch.match(/name: '@deepseek-ai\/dsh-client-ui-directory-picker-browse'/g) ?? [])).toHaveLength(1)
    expect(patch).not.toContain('@deepseek-ai/dsh-host-directory-picker-auto')
    expect(name).toBe('dsh-remote')
    expect(inject).toEqual(['webServer'])
  })
})
