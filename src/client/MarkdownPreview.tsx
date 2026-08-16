import { useMemo } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { vaultApi } from './api.ts'

interface Props {
  content: string
  notePath: string
  openNote(path: string): void
}

export function MarkdownPreview({ content, notePath, openNote }: Props) {
  const html = useMemo(() => renderMarkdown(content, notePath), [content, notePath])
  return (
    <div
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(event) => {
        const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[data-note-path]') : null
        if (target === null) return
        event.preventDefault()
        const path = target.dataset.notePath
        if (path !== undefined) openNote(path)
      }}
    />
  )
}

function renderMarkdown(content: string, notePath: string): string {
  const source = content
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, '')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/gu, (_all, target: string, label?: string) => {
      return `[${label ?? target}](obsidian:${encodeURIComponent(target)})`
    })
  const rendered = marked.parse(source, { async: false, gfm: true, breaks: false })
  const safe = DOMPurify.sanitize(rendered, {
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|obsidian):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/iu,
  })
  const template = document.createElement('template')
  template.innerHTML = safe
  const directory = notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : ''

  for (const link of template.content.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = link.getAttribute('href') ?? ''
    const local = localNoteTarget(href, directory)
    if (local !== null) {
      link.dataset.notePath = local
      link.href = '#'
    } else if (/^https?:/iu.test(href)) {
      link.target = '_blank'
      link.rel = 'noreferrer'
    }
  }
  for (const image of template.content.querySelectorAll<HTMLImageElement>('img[src]')) {
    const src = image.getAttribute('src') ?? ''
    if (!/^https?:/iu.test(src)) image.src = vaultApi.assetUrl(normalizeVaultPath(directory === '' ? src : `${directory}/${src}`))
    image.loading = 'lazy'
  }
  return template.innerHTML
}

function localNoteTarget(href: string, directory: string): string | null {
  if (href.startsWith('obsidian:')) return ensureMarkdown(decodeURIComponent(href.slice('obsidian:'.length)).split('#')[0] ?? '')
  if (/^[a-z]+:/iu.test(href) || href.startsWith('#')) return null
  const path = href.split('#')[0]
  if (path === undefined || path === '') return null
  return ensureMarkdown(normalizeVaultPath(directory === '' ? path : `${directory}/${path}`))
}

function ensureMarkdown(path: string): string {
  return path.toLocaleLowerCase().endsWith('.md') ? path : `${path}.md`
}

function normalizeVaultPath(path: string): string {
  const output: string[] = []
  for (const part of path.replaceAll('\\', '/').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') output.pop()
    else output.push(part)
  }
  return output.join('/')
}
