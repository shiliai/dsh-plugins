import type { Article } from '../contracts.ts'

export function articleContext(article: Article): string {
  const lines = ['[Reading item]', 'kind: article', `title: ${JSON.stringify(article.title)}`, `url: ${JSON.stringify(article.url)}`, `originalUrl: ${JSON.stringify(article.originalUrl ?? article.url)}`, `articleId: ${JSON.stringify(article.id)}`, `domain: ${JSON.stringify(article.domain ?? '')}`, `tags: ${JSON.stringify(article.tags ?? [])}`, `createdAt: ${JSON.stringify(article.savedAt)}`, `publishedAt: ${JSON.stringify(article.publishedAt ?? '')}`, `updatedAt: ${JSON.stringify(article.updatedAt ?? '')}`, `isArchived: ${JSON.stringify(article.isArchived)}`, `readingTimeMin: ${JSON.stringify(article.readingTimeMin ?? null)}`, `source: ${JSON.stringify(article.source)}`, `readingWorkspace: ${JSON.stringify(article.readingWorkspace ?? '')}`, `projectPath: ${JSON.stringify(article.projectPath ?? '')}`, `projectAbsolutePath: ${JSON.stringify(article.projectAbsolutePath ?? '')}`]
  if (article.vaultRoot !== undefined) lines.push(`vaultRoot: ${JSON.stringify(article.vaultRoot)}`)
  lines.push('The article is cached at projectAbsolutePath/article.md; use that absolute file path for the full reading text.', 'The listed readingWorkspace and vaultRoot directories are available for reading-related files.')
  return lines.join('\n')
}

export function bookContext(book: { id: string; title: string; format: string; fileName: string; projectPath?: string; projectAbsolutePath?: string; readingWorkspace?: string; vaultRoot?: string }): string {
  const lines = ['[Reading item]', 'kind: book', `title: ${JSON.stringify(book.title)}`, `bookId: ${JSON.stringify(book.id)}`, `format: ${JSON.stringify(book.format)}`, `fileName: ${JSON.stringify(book.fileName)}`, `readingWorkspace: ${JSON.stringify(book.readingWorkspace ?? '')}`, `projectPath: ${JSON.stringify(book.projectPath ?? '')}`, `projectAbsolutePath: ${JSON.stringify(book.projectAbsolutePath ?? '')}`]
  if (book.vaultRoot !== undefined) lines.push(`vaultRoot: ${JSON.stringify(book.vaultRoot)}`)
  lines.push('The reading workspace and projectAbsolutePath are available for reading-related files.')
  return lines.join('\n')
}
