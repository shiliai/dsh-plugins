import { parse } from 'yaml'

const FRONTMATTER = /^---[\t ]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[\t ]*(?:\r?\n|$)/u
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/u
const FENCE_CLOSE = /^ {0,3}(`+|~+)[\t ]*$/u
const INLINE_CODE = /(`+)(?:[^`]|`(?!\1))*?\1/gu
const HTML_COMMENT = /<!--[\s\S]*?-->/gu
const INLINE_TAG = /(^|[^\p{L}\p{M}\p{N}_\-/])#([\p{L}\p{M}\p{N}_-]+(?:\/[\p{L}\p{M}\p{N}_-]+)*)(?![\p{L}\p{M}\p{N}_\-/])/gmu

export function normalizeTag(input: string): string {
  return input.trim().replace(/^#+/u, '').normalize('NFC').toLocaleLowerCase()
}

export function isObsidianTag(input: string): boolean {
  const normalized = normalizeTag(input)
  return normalized !== ''
    && /[^\p{N}/]/u.test(normalized)
    && /^[\p{L}\p{M}\p{N}_-]+(?:\/[\p{L}\p{M}\p{N}_-]+)*$/u.test(normalized)
}

export function parseObsidianTags(content: string): string[] {
  const found = new Map<string, string>()
  const frontmatter = FRONTMATTER.exec(content)
  if (frontmatter !== null) {
    for (const value of frontmatterTags(frontmatter[1] ?? '')) addTag(found, value)
  }

  const markdown = content
    .slice(frontmatter?.[0].length ?? 0)
  const visibleMarkdown = stripFencedCode(markdown)
    .replace(INLINE_CODE, '')
    .replace(HTML_COMMENT, '')

  for (const match of visibleMarkdown.matchAll(INLINE_TAG)) addTag(found, match[2] ?? '')
  return [...found.values()]
}

export function tagAncestors(tag: string): string[] {
  const parts = tag.split('/')
  return parts.map((_part, index) => parts.slice(0, index + 1).join('/'))
}

function frontmatterTags(source: string): string[] {
  try {
    const document = parse(source, { maxAliasCount: 0 }) as unknown
    if (!isRecord(document)) return []
    const tags = document.tags
    if (Array.isArray(tags)) return tags.filter((value): value is string => typeof value === 'string')
    return typeof tags === 'string' ? [tags] : []
  } catch {
    return []
  }
}

function stripFencedCode(source: string): string {
  let fence: { marker: string; length: number } | undefined
  return source.split(/\r?\n/u).map(line => {
    if (fence === undefined) {
      const opening = FENCE_OPEN.exec(line)
      const sequence = opening?.[1]
      if (sequence === undefined) return line
      if (sequence[0] === '`' && (opening?.[2] ?? '').includes('`')) return line
      fence = { marker: sequence[0] ?? '', length: sequence.length }
      return ''
    }

    const closing = FENCE_CLOSE.exec(line)?.[1]
    if (closing !== undefined && closing[0] === fence.marker && closing.length >= fence.length) fence = undefined
    return ''
  }).join('\n')
}

function addTag(found: Map<string, string>, input: string): void {
  const display = input.trim().replace(/^#+/u, '').normalize('NFC')
  const normalized = normalizeTag(display)
  if (!isObsidianTag(normalized)) return
  if (!found.has(normalized)) found.set(normalized, display)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
