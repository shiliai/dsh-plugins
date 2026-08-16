import { describe, expect, it } from 'vitest'
import { resolveVaultNoteTarget } from '../src/client/MarkdownPreview.tsx'

describe('resolveVaultNoteTarget', () => {
  const paths = ['Home.md', 'Projects/Roadmap.md', 'Projects/Plan.md', 'Archive/Plan.md']

  it('resolves sibling, root, explicit, and anchored targets without guessing duplicates', () => {
    expect(resolveVaultNoteTarget('Roadmap', 'Projects/Plan.md', paths)).toBe('Projects/Roadmap.md')
    expect(resolveVaultNoteTarget('Home', 'Projects/Plan.md', paths)).toBe('Home.md')
    expect(resolveVaultNoteTarget('Projects/Roadmap#next', 'Home.md', paths)).toBe('Projects/Roadmap.md')
    expect(resolveVaultNoteTarget('Plan', 'Home.md', paths)).toBeNull()
  })

  it('makes malformed obsidian targets inert', () => {
    expect(resolveVaultNoteTarget('obsidian:%E0%A4%A', 'Home.md', paths)).toBeNull()
  })
})
