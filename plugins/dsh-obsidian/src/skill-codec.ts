import type { AgentSkillInput } from './contracts.ts'
import { AgentSkillValidationError, validateAgentSkillInput } from './validate-skill.ts'

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?([\s\S]*)$/

export interface ParsedAgentSkill {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
  instructions: string
  frontmatter: Record<string, unknown>
}

export class AgentSkillCodecError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AgentSkillCodecError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseScalar(raw: string): string {
  const value = raw.trim()
  if (value.length === 0) return ''
  if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2)
    || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
    const body = value.slice(1, -1)
    if (value.startsWith('"')) {
      return body.replace(/\\n/gu, '\n').replace(/\\"/gu, '"').replace(/\\\\/gu, '\\')
    }
    return body.replace(/''/gu, "'")
  }
  // Strip inline comment (only when not inside quotes, which we already handled).
  const hash = value.indexOf(' #')
  return (hash === -1 ? value : value.slice(0, hash)).trim()
}

// Minimal YAML frontmatter parser. Handles the scalar keys DSH skills use and
// preserves unknown scalar keys verbatim so edits do not silently drop them.
function parseFrontmatter(source: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const lines = source.split(/\r?\n/u)
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line === undefined) break
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) {
      index += 1
      continue
    }
    const sep = line.indexOf(':')
    if (sep === -1) {
      // Do not fail hard on non-`key:` lines; treat whole line as a comment-ish.
      index += 1
      continue
    }
    const key = line.slice(0, sep).trim()
    const valueRaw = line.slice(sep + 1)
    const valueTrimmed = valueRaw.trim()

    if (valueTrimmed === '|' || valueTrimmed === '|-' || valueTrimmed === '>' || valueTrimmed === '>-') {
      if (key === '') { index += 1; continue }
      const block: string[] = []
      index += 1
      while (index < lines.length) {
        const blockLine = lines[index]
        if (blockLine === undefined) break
        if (/^\S/u.test(blockLine)) break
        if (blockLine.trim() === '') { block.push(''); index += 1; continue }
        // Strip common indentation.
        const content = blockLine.replace(/^\s+/u, '')
        block.push(content)
        index += 1
      }
      result[key] = block.join('\n')
      continue
    }

    result[key] = parseScalar(valueRaw)
    index += 1
  }
  return result
}

function normalizeBoolean(key: string, raw: unknown): boolean | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === 'boolean') return raw
  if (typeof raw !== 'string') return undefined
  const value = raw.trim().toLocaleLowerCase()
  if (['true', 'yes', 'on', '1'].includes(value)) return true
  if (['false', 'no', 'off', '0'].includes(value)) return false
  return undefined
}

export function parseAgentSkillMarkdown(content: string, directoryName: string): ParsedAgentSkill {
  const match = content.match(FRONTMATTER_PATTERN)
  if (!match) {
    throw new AgentSkillCodecError('SKILL.md must start with YAML frontmatter')
  }

  const frontmatter = parseFrontmatter(match[1] ?? '')
  const name = frontmatter.name
  if (typeof name !== 'string' || name === '') {
    throw new AgentSkillCodecError('SKILL.md frontmatter requires a string name')
  }
  if (typeof frontmatter.description !== 'string') {
    throw new AgentSkillCodecError('SKILL.md frontmatter requires a string description')
  }
  if (name !== directoryName) {
    throw new AgentSkillCodecError('SKILL.md name must match its containing directory')
  }

  const whenToUse = typeof frontmatter.whenToUse === 'string' ? frontmatter.whenToUse || undefined : undefined
  const modelInvocable = normalizeBoolean('disable-model-invocation', frontmatter['disable-model-invocation'])
  const userInvocable = normalizeBoolean('user-invocable', frontmatter['user-invocable'])

  const parsed: ParsedAgentSkill = {
    name,
    description: frontmatter.description.trim(),
    ...(whenToUse === undefined ? {} : { whenToUse: whenToUse.trim() }),
    modelInvocable: modelInvocable === undefined ? true : !modelInvocable, // invert disable flag
    userInvocable: userInvocable === undefined ? true : userInvocable,
    instructions: (match[2] ?? '').replace(/\r\n/gu, '\n').trim(),
    frontmatter,
  }
  return parsed
}

function quoteYamlString(value: string): string {
  if (/^[A-Za-z0-9_ .\-/:()[\],?<>~*&%$!@#^+=;|'"]*$/u.test(value) && !/[":#\n]/u.test(value) && value.trim() === value) {
    return value
  }
  return JSON.stringify(value)
}

function serializeFrontmatter(frontmatter: Record<string, unknown>): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined) continue
    if (typeof value === 'string') {
      if (value.includes('\n')) {
        lines.push(`${key}: |-`)
        for (const part of value.split('\n')) {
          lines.push(`  ${part}`)
        }
      } else {
        lines.push(`${key}: ${quoteYamlString(value)}`)
      }
    } else if (typeof value === 'boolean') {
      lines.push(`${key}: ${value ? 'true' : 'false'}`)
    } else if (typeof value === 'number') {
      lines.push(`${key}: ${value}`)
    } else {
      lines.push(`${key}: ${JSON.stringify(value)}`)
    }
  }
  return lines.join('\n')
}

export function serializeAgentSkillMarkdown(
  currentFrontmatter: Record<string, unknown>,
  input: AgentSkillInput,
): string {
  validateAgentSkillInput(input)
  const frontmatter: Record<string, unknown> = {
    ...currentFrontmatter,
    name: input.name,
    description: input.description.trim(),
    ...(input.whenToUse !== undefined && input.whenToUse.trim() !== ''
      ? { whenToUse: input.whenToUse.trim() } : {}),
    'disable-model-invocation': !input.modelInvocable,
    'user-invocable': input.userInvocable,
  }
  // Drop stale keys that no longer apply.
  if (input.whenToUse === undefined || input.whenToUse.trim() === '') {
    delete frontmatter.whenToUse
  }
  return `---\n${serializeFrontmatter(frontmatter)}\n---\n${input.instructions.trim()}\n`
}
