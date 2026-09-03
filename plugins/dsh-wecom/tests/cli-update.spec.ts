import { describe, expect, it, vi } from 'vitest'
import { CliUpdateManager, compareVersions, parseInstalledVersion, parseLatestVersion } from '../src/cli-update.ts'

describe('CliUpdateManager', () => {
  it('parses installed and registry versions', () => {
    expect(parseInstalledVersion('wecom-cli 1.1.0 (wecom build)\n')).toBe('1.1.0')
    expect(parseLatestVersion('"1.2.0"\n')).toBe('1.2.0')
    expect(compareVersions('1.2.0-beta.2', '1.2.0')).toBeLessThan(0)
    expect(compareVersions('1.10.0', '1.2.0')).toBeGreaterThan(0)
  })

  it('checks the installed CLI against the npm registry', async () => {
    const run = vi.fn(async (command: string, args: string[]) => command === 'npm' && args[0] === 'view' ? '"1.2.0"' : 'wecom-cli 1.1.0 (wecom build)')
    await expect(new CliUpdateManager(run).check()).resolves.toMatchObject({ installed: '1.1.0', latest: '1.2.0', state: 'outdated', updated: false })
    expect(run).toHaveBeenNthCalledWith(1, 'npm', ['view', '@wecom/cli', 'version', '--json'])
    expect(run).toHaveBeenNthCalledWith(2, 'wecom-cli', ['--version'])
  })

  it('installs the official package globally and verifies the result', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce('"1.2.0"')
      .mockResolvedValueOnce('wecom-cli 1.1.0')
      .mockResolvedValueOnce('updated package')
      .mockResolvedValueOnce('"1.2.0"')
      .mockResolvedValueOnce('wecom-cli 1.2.0')
    await expect(new CliUpdateManager(run).update()).resolves.toMatchObject({ state: 'current', installed: '1.2.0', updated: true })
    expect(run).toHaveBeenNthCalledWith(3, 'npm', ['install', '--global', '@wecom/cli@latest'])
  })

  it('installs when wecom-cli is missing', async () => {
    const missing = Object.assign(new Error('not found'), { code: 'ENOENT' })
    const run = vi.fn()
      .mockResolvedValueOnce('"1.2.0"')
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce('installed package')
      .mockResolvedValueOnce('"1.2.0"')
      .mockResolvedValueOnce('wecom-cli 1.2.0')
    await expect(new CliUpdateManager(run).update()).resolves.toMatchObject({ installed: '1.2.0', updated: true })
  })

  it('does not downgrade a current or newer CLI', async () => {
    const run = vi.fn(async (command: string) => command === 'npm' ? '"1.2.0"' : 'wecom-cli 1.3.0')
    await expect(new CliUpdateManager(run).update()).resolves.toMatchObject({ state: 'ahead', updated: false })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('serializes concurrent operations', async () => {
    let release!: (value: string) => void
    const latest = new Promise<string>((resolve) => { release = resolve })
    const run = vi.fn((command: string) => command === 'npm' ? latest : Promise.resolve('wecom-cli 1.2.0'))
    const updates = new CliUpdateManager(run)
    const first = updates.check()
    const second = updates.check()
    expect(second).toBe(first)
    release('"1.2.0"')
    await expect(first).resolves.toMatchObject({ state: 'current' })
  })
})
