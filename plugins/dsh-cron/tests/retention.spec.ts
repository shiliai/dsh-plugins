import { describe, expect, it } from 'vitest'
import { SessionRetainer, type RetainableHandle } from '../src/retention.ts'

function fakeHandle(sessionId: string): { handle: RetainableHandle; disposals: string[] } {
  const disposals: string[] = []
  return {
    disposals,
    handle: {
      sessionId,
      dispose: async () => { disposals.push(sessionId) },
    },
  }
}

describe('SessionRetainer', () => {
  it('keeps the newest N handles and disposes the evicted oldest', async () => {
    const a = fakeHandle('session-a')
    const b = fakeHandle('session-b')
    const c = fakeHandle('session-c')
    const retainer = new SessionRetainer(2, () => undefined)
    retainer.keep(a.handle)
    retainer.keep(b.handle)
    retainer.keep(c.handle)
    await Promise.resolve()
    expect(a.disposals).toEqual(['session-a'])
    expect(b.disposals).toEqual([])
    expect(c.disposals).toEqual([])
  })

  it('re-keeping a session moves it to newest instead of duplicating', async () => {
    const a = fakeHandle('session-a')
    const b = fakeHandle('session-b')
    const retainer = new SessionRetainer(2, () => undefined)
    retainer.keep(a.handle)
    retainer.keep(b.handle)
    retainer.keep(a.handle)
    const c = fakeHandle('session-c')
    retainer.keep(c.handle)
    await Promise.resolve()
    // b is now the oldest and gets evicted; a stays alive.
    expect(b.disposals).toEqual(['session-b'])
    expect(a.disposals).toEqual([])
  })

  it('limit 0 disposes immediately (legacy release behavior)', async () => {
    const a = fakeHandle('session-a')
    const retainer = new SessionRetainer(0, () => undefined)
    retainer.keep(a.handle)
    await Promise.resolve()
    expect(a.disposals).toEqual(['session-a'])
  })

  it('disposeAll releases everything and survives dispose failures', async () => {
    const good = fakeHandle('session-good')
    const bad: { handle: RetainableHandle; disposals: string[] } = {
      disposals: [],
      handle: {
        sessionId: 'session-bad',
        dispose: async () => { throw new Error('already gone') },
      },
    }
    const retainer = new SessionRetainer(8, () => undefined)
    retainer.keep(good.handle)
    retainer.keep(bad.handle)
    await retainer.disposeAll()
    expect(good.disposals).toEqual(['session-good'])
    expect(retainer.disposeAll()).resolves.toBeUndefined()
  })
})
