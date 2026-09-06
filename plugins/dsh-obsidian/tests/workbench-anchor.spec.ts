import { describe, expect, it } from 'vitest'
import { findConversationAnchor } from '../src/client/workbench-anchor.ts'

describe('findConversationAnchor', () => {
  it('prefers an active conversation and ignores inputs', () => {
    const viewArea = { tagName: 'MAIN', children: [], querySelector: () => ({}), scrollHeight: 100, clientHeight: 50 }
    const header = { tagName: 'HEADER', children: [] }
    const active = { tagName: 'DIV', children: [header, viewArea], dataset: { phase: 'active' } }
    const hero = { tagName: 'DIV', children: [{}, {}], dataset: { phase: 'hero' } }
    const anchor = findConversationAnchor({ querySelectorAll: () => [hero, active] } as never)
    expect(anchor?.root.dataset.phase).toBe('active')
    expect(anchor?.header?.tagName).toBe('HEADER')
    expect(anchor?.viewArea.tagName).toBe('MAIN')
  })

  it('returns null when the host has no conversation root', () => {
    expect(findConversationAnchor({ querySelectorAll: () => [{ tagName: 'DIV', children: [], dataset: { phase: 'active' } }] } as never)).toBeNull()
  })
})
