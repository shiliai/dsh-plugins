import { useMemo } from 'react'
import DOMPurify from 'dompurify'
import { marked, Renderer } from 'marked'
import { vaultApi } from './api.ts'

interface Props {
  content: string
  notePath: string
  notePaths: readonly string[]
  openNote(path: string): void
}

export function MarkdownPreview({ content, notePath, notePaths, openNote }: Props) {
  const html = useMemo(() => renderMarkdown(content, notePath, notePaths), [content, notePath, notePaths])
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

export function renderMarkdown(content: string, notePath: string, notePaths: readonly string[]): string {
  const source = content
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, '')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/gu, (_all, target: string, label?: string) => {
      return `[${label ?? target}](obsidian:${encodeURIComponent(target)})`
    })
  const renderer = new Renderer()
  renderer.html = () => ''
  const rendered = marked.parse(source, { async: false, gfm: true, breaks: false, renderer })
  const safe = DOMPurify.sanitize(rendered, {
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|obsidian):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/iu,
    FORBID_TAGS: ['style', 'form', 'button', 'select', 'textarea', 'label', 'fieldset', 'legend', 'dialog', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['style', 'formaction', 'formmethod', 'formtarget'],
  })
  const template = document.createElement('template')
  template.innerHTML = safe
  const directory = notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : ''

  for (const link of template.content.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = link.getAttribute('href') ?? ''
    const local = resolveVaultNoteTarget(href, notePath, notePaths)
    if (local !== null) {
      link.dataset.notePath = local
      link.href = '#'
    } else if (href.startsWith('obsidian:')) {
      link.removeAttribute('href')
      link.setAttribute('aria-disabled', 'true')
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
  for (const input of template.content.querySelectorAll<HTMLInputElement>('input')) {
    if (input.type !== 'checkbox' || input.closest('li.task-list-item') === null) input.remove()
    else {
      input.disabled = true
      input.tabIndex = -1
      input.removeAttribute('style')
    }
  }
  return template.innerHTML
}

export function resolveVaultNoteTarget(href: string, notePath: string, notePaths: readonly string[]): string | null {
  let target = href
  if (href.startsWith('obsidian:')) {
    try {
      target = decodeURIComponent(href.slice('obsidian:'.length))
    } catch {
      return null
    }
  }
  if ((/^[a-z]+:/iu.test(href) && !href.startsWith('obsidian:')) || href.startsWith('#')) return null
  const path = target.split('#')[0]
  if (path === undefined || path === '') return null
  const directory = notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : ''
  const indexed = new Set(notePaths)
  const explicit = path.includes('/') || path.toLocaleLowerCase().endsWith('.md')
  if (explicit) {
    const resolved = ensureMarkdown(normalizeVaultPath(path.includes('/') && !path.startsWith('../') ? path : `${directory}/${path}`))
    return indexed.has(resolved) ? resolved : null
  }
  const sibling = ensureMarkdown(normalizeVaultPath(directory === '' ? path : `${directory}/${path}`))
  if (indexed.has(sibling)) return sibling
  const root = ensureMarkdown(normalizeVaultPath(path))
  if (indexed.has(root)) return root
  const matches = notePaths.filter(candidate => candidate === root || candidate.endsWith(`/${root}`))
  return matches.length === 1 ? matches[0] ?? null : null
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
