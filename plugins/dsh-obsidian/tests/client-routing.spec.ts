import { describe, expect, it, vi } from 'vitest'
import { apply, panelTargetFor } from '../src/client/index.tsx'
import type { SessionListView } from '../src/client/vault-landing.ts'

/** 0.2 hosts carry no `current`: the main view is the `mainView`-retained row. */
function snapshotWith(mainView: string | undefined, rows: SessionListView['byId'] = {}): SessionListView {
  const byId = { ...rows }
  if (mainView !== undefined) byId[mainView] = { ...byId[mainView], retainedBy: { mainView: 1 } }
  return { byId }
}

describe('panelTargetFor', () => {
  it('keeps the composer seat usable for a blank current session', () => {
    expect(panelTargetFor(snapshotWith(undefined))).toBe('main.conversation')
    expect(panelTargetFor(snapshotWith('blank', { blank: { blank: true } }))).toBe('conversation.session')
    expect(panelTargetFor(snapshotWith('active', { active: { blank: false } }))).toBe('rightbar')
  })

  it('prefers the main-view retention over a legacy explicit current', () => {
    const snapshot = snapshotWith('retained', { stale: { blank: false } })
    snapshot.current = 'stale'
    expect(panelTargetFor(snapshot)).toBe('conversation.session')
  })

  it('reseats an already-open note panel when the current session changes', async () => {
    let snapshot = snapshotWith(undefined)
    let listener: (() => void) | undefined
    const registrations: Array<{ name: string; inject?: () => Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: 'fixture', code: 'FIXTURE' }) })))
    const layoutCalls: Array<[string, ...unknown[]]> = []
    apply({
      slots: {
        inject: (_name: string, register: () => (() => void)) => { register() },
        register: (options: { name: string; inject?: () => Record<string, unknown> }) => {
          registrations.push(options)
          return () => undefined
        },
      },
      layout: {
        openRightbar: (...args: unknown[]) => { layoutCalls.push(['openRightbar', ...args]) },
        closeRightbar: () => { layoutCalls.push(['closeRightbar']) },
      },
      sessions: { list: { getSnapshot: () => snapshot, subscribe: (next: () => void) => { listener = next; return () => undefined } } },
      effect() {},
    } as never)

    const settings = registrations.find(registration => registration.name === 'settings.plugins.tab')
    const store = settings?.inject?.().store as { openNote(path: string): Promise<void> }
    void store.openNote('Home.md')
    await Promise.resolve()
    expect(registrations.map(registration => registration.name)).toContain('main.conversation')

    snapshot = snapshotWith('blank', { blank: { blank: true } })
    listener?.()
    snapshot = snapshotWith('active', { active: { blank: false } })
    listener?.()
    expect(registrations.map(registration => registration.name)).toEqual(expect.arrayContaining(['conversation.session', 'rightbar']))
    expect(layoutCalls).toEqual([['openRightbar', true, false]])
    vi.unstubAllGlobals()
  })
})
