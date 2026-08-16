import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveRuntimeConfig } from '../src/remote-service.ts'

const config = {
  remoteOrigin: 'https://zsh.onlyservice.io',
  sshTarget: 'dsh@vps-tencent-tokyo',
  remoteSocketPath: '/home/chriswang/.local/share/dsh-remote/tunnel.sock',
  stateFile: '/tmp/dsh-remote-state.json',
}

afterEach(() => { vi.unstubAllEnvs() })

describe('resolveRuntimeConfig', () => {
  it('uses environment-only test overrides without placing credentials in configuration', () => {
    vi.stubEnv('DSH_REMOTE_ORIGIN', 'https://fixture.invalid')
    vi.stubEnv('DSH_REMOTE_SSH_TARGET', 'fixture@localhost')
    vi.stubEnv('DSH_REMOTE_STATE_FILE', '/tmp/fixture-state.json')
    expect(resolveRuntimeConfig({ host: '127.0.0.1', port: 3080 }, config)).toMatchObject({
      remoteOrigin: 'https://fixture.invalid',
      sshTarget: 'fixture@localhost',
      stateFile: '/tmp/fixture-state.json',
      remoteSocketPath: config.remoteSocketPath,
    })
  })

  it('fails closed for non-loopback bindings and unsafe SSH forwarding input', () => {
    expect(() => resolveRuntimeConfig({ host: '0.0.0.0', port: 3080 }, config)).toThrow('webServer must remain bound to loopback')
    expect(() => resolveRuntimeConfig({ host: '127.0.0.1', port: 3080 }, { ...config, gatewayHost: '0.0.0.0' as never })).toThrow('gatewayHost must be 127.0.0.1')
    for (const sshTarget of ['-oProxyCommand=bad', 'dsh@host;bad', 'dsh@@host', 'host..example']) {
      expect(() => resolveRuntimeConfig({ host: '127.0.0.1', port: 3080 }, { ...config, sshTarget })).toThrow('safe alias or user@host')
    }
    for (const remoteSocketPath of ['relative.sock', '/tmp/../tunnel.sock', '/tmp/tunnel:sock', '/tmp/tunnel\n.sock', '/tmp//tunnel.sock']) {
      expect(() => resolveRuntimeConfig({ host: '127.0.0.1', port: 3080 }, { ...config, remoteSocketPath })).toThrow('safe absolute Unix socket path')
    }
  })
})
