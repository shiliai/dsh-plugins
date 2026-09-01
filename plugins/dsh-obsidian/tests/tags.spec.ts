import { describe, expect, it } from 'vitest'
import { isObsidianTag, normalizeTag, parseObsidianTags, tagAncestors } from '../src/tags.ts'

describe('Obsidian tags', () => {
  it('combines YAML and inline tags while excluding code and invalid numeric tags', () => {
    const content = [
      '---',
      'tags:',
      '  - Project/Atlas',
      '  - meeting',
      '---',
      '# Notes',
      'Discuss #Meeting and #状态/进行中.',
      '`#inline-code`',
      '```text',
      '#fenced-code',
      '```',
      'Do not match https://example.test/#fragment or #123.',
    ].join('\n')

    expect(parseObsidianTags(content)).toEqual(['Project/Atlas', 'meeting', '状态/进行中'])
  })

  it('accepts scalar YAML tags and ignores malformed frontmatter without losing body tags', () => {
    expect(parseObsidianTags('---\ntags: project/one\n---\n#body')).toEqual(['project/one', 'body'])
    expect(parseObsidianTags('---\ntags: [broken\n---\n#body')).toEqual(['body'])
  })

  it('honors longer closing fences and rejects malformed nested tags', () => {
    expect(parseObsidianTags('```text\n#hidden\n````\n#visible')).toEqual(['visible'])
    expect(parseObsidianTags('#project//atlas #project/')).toEqual([])
  })

  it('normalizes names and derives nested parents', () => {
    expect(normalizeTag('#Project/Atlas')).toBe('project/atlas')
    expect(tagAncestors('Project/Atlas/Meetings')).toEqual(['Project', 'Project/Atlas', 'Project/Atlas/Meetings'])
    expect(isObsidianTag('project/atlas')).toBe(true)
    expect(isObsidianTag('123')).toBe(false)
    expect(isObsidianTag('project//atlas')).toBe(false)
  })
})
