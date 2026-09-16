import { describe, expect, it } from 'vitest'
import { articleContext, bookContext } from '../src/client/context.ts'

describe('conversation reading context', () => {
  it('uses absolute project paths so article files resolve outside the current cwd', () => {
    const value = articleContext({
      id: 'wallabag:1', source: 'wallabag', url: 'https://example.com/a', title: 'Article', isArchived: false, savedAt: '2026-01-01',
      readingWorkspace: '/data/reading/workspaces', projectPath: 'articles/abc-article', projectAbsolutePath: '/data/reading/workspaces/articles/abc-article', vaultRoot: '/data/vault',
    })
    expect(value).toContain('absolutePath: "/data/reading/workspaces/articles/abc-article/article.md"')
    expect(value).toContain('availableWorkspaces:')
    expect(value).toContain('path: "/data/vault"')
  })

  it('includes the reading workspace for book references too', () => {
    const value = bookContext({ id: 'local:1', title: 'Book', format: 'epub', fileName: 'book.epub', readingWorkspace: '/data/reading/workspaces', projectAbsolutePath: '/data/reading/workspaces/books/abc-book' })
    expect(value).toContain('path: "/data/reading/workspaces"')
    expect(value).toContain('absolutePath: "/data/reading/workspaces/books/abc-book"')
  })
})
