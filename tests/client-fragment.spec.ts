import { describe, expect, it, vi } from 'vitest'
import { clearAccessFragment } from '../src/client/index.tsx'

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
