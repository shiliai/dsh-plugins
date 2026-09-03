import { describe, expect, it, vi } from 'vitest'
import { clearAccessFragment, enableOwnerConfigurationPlane, enableRemoteConfigurationPlane } from '../src/client/index.tsx'

describe('authenticated access fragment cleanup', () => {
  it('removes only a canonical private access fragment', () => {
    const replaceState = vi.fn()
    expect(clearAccessFragment({ hash: `#/access/${'a'.repeat(43)}`, pathname: '/workspace', search: '?view=active' }, { replaceState })).toBe(true)
    expect(replaceState).toHaveBeenCalledWith(null, '', '/workspace?view=active')
  })

  it.each(['#/access/short', `#/access/${'!'.repeat(43)}`, '#/settings', ''])('preserves unrelated or malformed hash %s', hash => {
    const replaceState = vi.fn()
    expect(clearAccessFragment({ hash, pathname: '/', search: '' }, { replaceState })).toBe(false)
    expect(replaceState).not.toHaveBeenCalled()
  })
})

describe('authenticated remote configuration-plane compatibility', () => {
  it('enables the existing rc.8 settings mirror for every authenticated remote app', () => {
    const load = vi.fn(async () => undefined)
    const mirror = { persistence: 'memory', load }

    expect(enableRemoteConfigurationPlane({ describe: () => mirror })).toBe(true)
    expect(mirror.persistence).toBe('host')
    expect(load).toHaveBeenCalledOnce()
  })

  it('keeps the legacy owner-cookie helper and rc.6 compatibility', () => {
    expect(enableOwnerConfigurationPlane('theme=dark', {})).toBe(false)
    expect(enableOwnerConfigurationPlane('__Host-dsh_remote_owner_ui=1', {})).toBe(true)
    expect(enableRemoteConfigurationPlane({})).toBe(true)
  })
})
