import type { Article } from '../contracts.ts'
import { formatContext, type ContextReference, type ContextWorkspace } from '@dsh-plugins/dsh-reading-core'

export function articleContext(article: Article): string {
  const workspaces: ContextWorkspace[] = article.readingWorkspace === undefined ? [] : [{ id: 'reading', label: 'Reading', path: article.readingWorkspace, writable: false }]
  if (article.vaultRoot !== undefined) workspaces.push({ id: 'vault', label: 'Obsidian vault', path: article.vaultRoot, writable: true })
  const reference: ContextReference = { source: 'reading-article', workspaces, entries: [{ type: 'article', title: article.title, ...(article.projectPath === undefined ? {} : { path: article.projectPath }), ...(article.projectAbsolutePath === undefined ? {} : { absolutePath: `${article.projectAbsolutePath}/article.md` }), workspaceId: 'reading', metadata: { url: article.url, originalUrl: article.originalUrl ?? article.url, articleId: article.id, domain: article.domain ?? '', tags: article.tags ?? [], savedAt: article.savedAt, publishedAt: article.publishedAt ?? '', updatedAt: article.updatedAt ?? '', isArchived: article.isArchived, readingTimeMin: article.readingTimeMin ?? null, source: article.source } }], instructions: ['Use the absolutePath above for the full article text.'] }
  return formatContext(reference)
}

export function bookContext(book: { id: string; title: string; format: string; fileName: string; projectPath?: string; projectAbsolutePath?: string; readingWorkspace?: string; vaultRoot?: string }): string {
  const workspaces: ContextWorkspace[] = book.readingWorkspace === undefined ? [] : [{ id: 'reading', label: 'Reading', path: book.readingWorkspace, writable: false }]
  if (book.vaultRoot !== undefined) workspaces.push({ id: 'vault', label: 'Obsidian vault', path: book.vaultRoot, writable: true })
  return formatContext({ source: 'reading-book', workspaces, entries: [{ type: 'book', title: book.title, ...(book.projectPath === undefined ? {} : { path: book.projectPath }), ...(book.projectAbsolutePath === undefined ? {} : { absolutePath: book.projectAbsolutePath }), workspaceId: 'reading', metadata: { bookId: book.id, format: book.format, fileName: book.fileName } }], instructions: ['Use projectAbsolutePath for reading-related files.'] })
}
