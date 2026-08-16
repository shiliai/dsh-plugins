import { describe, expect, it, vi } from 'vitest'
import { apply, panelTargetFor } from '../src/client/index.tsx'

describe('panelTargetFor', () => {
  it('keeps the composer seat usable for a blank current session', () => {
    expect(panelTargetFor({ current: undefined, byId: {} })).toBe('conversation')
    expect(panelTargetFor({ current: 'blank', byId: { blank: { blank: true } } })).toBe('conversation.session')
    expect(panelTargetFor({ current: 'active', byId: { active: { blank: false } } })).toBe('details')
  })

  it('reseats an already-open note panel when the current session changes', async () => {
    let snapshot = { current: undefined as string | undefined, byId: {} as Record<string, { blank: boolean }> }
    let listener: (() => void) | undefined
    const registrations: Array<{ name: string; inject?: () => Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: 'fixture', code: 'FIXTURE' }) })))
    apply({
      slots: {
        inject: (_name: string, register: () => (() => void)) => { register() },
        register: (options: { name: string; inject?: () => Record<string, unknown> }) => {
          registrations.push(options)
          return () => undefined
        },
      },
      layout: { openDetails() {}, closeDetails() {} },
      sessions: { list: { getSnapshot: () => snapshot, subscribe: (next: () => void) => { listener = next; return () => undefined } } },
      effect() {},
    } as never)

    const footer = registrations.find(registration => registration.name === 'sidebar.footer.action')
    const openBrowser = footer?.inject?.().openBrowser as (() => void)
    openBrowser()
    const browser = registrations.find(registration => registration.name === 'sidebar.workspaces')
    const store = browser?.inject?.().store as { openNote(path: string): Promise<void> }
    void store.openNote('Home.md')
    await Promise.resolve()
    expect(registrations.map(registration => registration.name)).toContain('conversation')

    snapshot = { current: 'blank', byId: { blank: { blank: true } } }
    listener?.()
    snapshot = { current: 'active', byId: { active: { blank: false } } }
    listener?.()
    expect(registrations.map(registration => registration.name)).toEqual(expect.arrayContaining(['conversation.session', 'details']))
    vi.unstubAllGlobals()
  })
})
