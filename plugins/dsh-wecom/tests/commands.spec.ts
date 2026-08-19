import { describe, expect, it } from 'vitest'
import { parseCommand, renderHelp, resolveWorkingDir } from '../src/commands.ts'

describe('parseCommand', () => {
  it('parses a plain slash command', () => {
    expect(parseCommand('/help')).toEqual({ name: 'help', arg: '' })
    expect(parseCommand('  /NEW   ')).toEqual({ name: 'new', arg: '' })
  })

  it('captures the argument after the command', () => {
    expect(parseCommand('/cd /Users/foo/bar')).toEqual({ name: 'cd', arg: '/Users/foo/bar' })
    expect(parseCommand('/agent  标准模式 ')).toEqual({ name: 'agent', arg: '标准模式' })
  })

  it('returns undefined for non-command text', () => {
    expect(parseCommand('hello')).toBeUndefined()
    expect(parseCommand('')).toBeUndefined()
    expect(parseCommand('a/b')).toBeUndefined()
  })
})

describe('renderHelp', () => {
  it('lists all commands', () => {
    const help = renderHelp()
    for (const c of ['/help', '/new', '/cd', '/agent', '/status']) {
      expect(help).toContain(c)
    }
  })
})

describe('resolveWorkingDir', () => {
  it('uses the base for relative paths', () => {
    expect(resolveWorkingDir('src', '/a/b')).toBe('/a/b/src')
  })

  it('keeps absolute paths', () => {
    expect(resolveWorkingDir('/x/y', '/a/b')).toBe('/x/y')
  })

  it('falls back to home for empty/~', () => {
    expect(resolveWorkingDir('', '/a')).toBe(process.env.HOME)
    expect(resolveWorkingDir('~', '/a')).toBe(process.env.HOME)
  })

  it('expands tilde paths', () => {
    expect(resolveWorkingDir('~/doc', '/a')).toBe(`${process.env.HOME}/doc`)
  })
})
