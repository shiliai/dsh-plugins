import { describe, expect, it } from 'vitest'
import { appendContext, formatContext } from '../src/context.ts'

describe('shared reading context', () => {
  it('formats absolute entries and registered workspaces in one protocol', () => {
    const value = formatContext({ source: 'reading', workspaces: [{ id: 'reading', label: 'Reading', path: '/data/reading' }], entries: [{ type: 'article', title: 'A', path: 'articles/a', absolutePath: '/data/reading/articles/a/article.md', workspaceId: 'reading' }] })
    expect(value).toContain('availableWorkspaces:')
    expect(value).toContain('absolutePath: "/data/reading/articles/a/article.md"')
  })

  it('appends blocks without dropping existing draft content', () => {
    expect(appendContext('Question', { source: 'vault', workspaces: [], entries: [{ type: 'note', path: 'Home.md' }] })).toMatch(/^Question\n\n\[Reading context\]/u)
  })
})
