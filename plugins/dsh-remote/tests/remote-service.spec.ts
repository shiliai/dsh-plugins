import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveRuntimeConfig } from '../src/remote-service.ts'

const config = {
  remoteOrigin: 'https://zsh.onlyservice.io',
  sshTarget: 'dsh@vps-tencent-tokyo',
  remoteSocketPath: '/home/chriswang/.local/share/dsh-remote/tunnel.sock',
  stateFile: '/tmp/dsh-remote-state.json',
}
const configWithoutState = {
  remoteOrigin: config.remoteOrigin,
  sshTarget: config.sshTarget,
  remoteSocketPath: config.remoteSocketPath,
}

afterEach(() => { vi.unstubAllEnvs() })

describe('resolveRuntimeConfig', () => {
  it('uses environment-only test overrides without placing credentials in configuration', () => {
    vi.stubEnv('DSH_REMOTE_ORIGIN', 'https://fixture.invalid')
    vi.stubEnv('DSH_REMOTE_SSH_TARGET', 'fixture@localhost')
    vi.stubEnv('DSH_REMOTE_STATE_FILE', '/tmp/fixture-state.json')
    vi.stubEnv('DSH_REMOTE_INITIAL_TOKEN', Buffer.alloc(32, 3).toString('base64url'))
    expect(resolveRuntimeConfig({ host: '127.0.0.1', port: 3080 }, config)).toMatchObject({
      remoteOrigin: 'https://fixture.invalid',
      sshTarget: 'fixture@localhost',
      stateFile: '/tmp/fixture-state.json',
      initialToken: Buffer.alloc(32, 3).toString('base64url'),
      remoteSocketPath: config.remoteSocketPath,
    })
  })

  it('derives isolated origin, socket, and state paths from a safe instance id', () => {
    vi.stubEnv('DSH_REMOTE_INSTANCE_ID', 'x570')
    const resolved = resolveRuntimeConfig({ host: '127.0.0.1', port: 3080 }, configWithoutState)
    expect(resolved).toMatchObject({
      instanceId: 'x570',
      remoteOrigin: 'https://x570.dsh.onlyservice.io',
      remoteSocketPath: '/home/chriswang/.local/share/dsh-remote/instances/x570.sock',
    })
    expect(resolved.stateFile).toMatch(/\/dsh-remote\/instances\/x570\.json$/u)
  })

  it('allows explicit multi-instance routing overrides', () => {
    vi.stubEnv('DSH_REMOTE_INSTANCE_ID', 'build-01')
    vi.stubEnv('DSH_REMOTE_BASE_DOMAIN', 'remote.example.com')
    vi.stubEnv('DSH_REMOTE_SOCKET_PATH', '/srv/dsh/build-01.sock')
    expect(resolveRuntimeConfig({ host: '127.0.0.1', port: 3080 }, configWithoutState)).toMatchObject({
      remoteOrigin: 'https://build-01.remote.example.com',
      remoteSocketPath: '/srv/dsh/build-01.sock',
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
    for (const instanceId of ['X570', '-x570', 'x570-', 'x..570', 'x--570']) {
      vi.stubEnv('DSH_REMOTE_INSTANCE_ID', instanceId)
      expect(() => resolveRuntimeConfig({ host: '127.0.0.1', port: 3080 }, config)).toThrow('instanceId')
    }
  })

  it('uses a fixed Gateway and mode-restricted Agent socket in Host mode', () => {
    vi.stubEnv('DSH_REMOTE_MODE', 'host')
		vi.stubEnv('DSH_REMOTE_SSH_COMPATIBILITY', 'true')
    vi.stubEnv('DSH_REMOTE_AGENT_SOCKET_PATH', '/tmp/dsh-agent.sock')
    expect(resolveRuntimeConfig({ host: '127.0.0.1', port: 3080 }, config)).toMatchObject({
			mode: 'host', sshCompatibility: true, gatewayPort: 29321, agentSocketPath: '/tmp/dsh-agent.sock',
    })
    expect(() => resolveRuntimeConfig({ host: '127.0.0.1', port: 3080 }, { ...config, gatewayPort: 0 })).toThrow('fixed gatewayPort')
  })
})
