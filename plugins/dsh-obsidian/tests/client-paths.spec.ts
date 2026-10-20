import { describe, expect, it } from 'vitest'
import { formatBytes, formatTimestamp } from '../src/client/format.ts'
import { absoluteVaultPath } from '../src/client/paths.ts'

describe('absoluteVaultPath', () => {
  it('joins a POSIX vault root with a vault-relative path', () => {
    expect(absoluteVaultPath('/Users/me/Vault', 'Projects/Roadmap.md')).toBe('/Users/me/Vault/Projects/Roadmap.md')
  })

  it('tolerates a trailing separator on the root and a leading one on the path', () => {
    expect(absoluteVaultPath('/Users/me/Vault/', 'Projects/Roadmap.md')).toBe('/Users/me/Vault/Projects/Roadmap.md')
    expect(absoluteVaultPath('/Users/me/Vault', '/Projects/Roadmap.md')).toBe('/Users/me/Vault/Projects/Roadmap.md')
  })

  it('keeps a Windows root in Windows form', () => {
    expect(absoluteVaultPath('C:\\Users\\me\\Vault', 'Projects/Roadmap.md')).toBe('C:\\Users\\me\\Vault\\Projects\\Roadmap.md')
    expect(absoluteVaultPath('C:\\Users\\me\\Vault\\', 'Notes\\Today.md')).toBe('C:\\Users\\me\\Vault\\Notes\\Today.md')
  })

  it('returns the root unchanged when the path is empty', () => {
    expect(absoluteVaultPath('/Users/me/Vault', '')).toBe('/Users/me/Vault')
    expect(absoluteVaultPath('', 'Home.md')).toBe('Home.md')
  })
})

describe('formatBytes', () => {
  it('renders byte-exact sizes below one kilobyte', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(812)).toBe('812 B')
  })

  it('scales through the unit table with one decimal below ten', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(12.5 * 1024 * 1024)).toBe('13 MB')
    expect(formatBytes(3 * 1024 ** 4)).toBe('3.0 TB')
  })

  it('renders absent or invalid sizes as an em dash', () => {
    expect(formatBytes(undefined)).toBe('—')
    expect(formatBytes(Number.NaN)).toBe('—')
    expect(formatBytes(-1)).toBe('—')
  })
})

describe('formatTimestamp', () => {
  it('renders a real timestamp in local time', () => {
    expect(formatTimestamp(Date.UTC(2026, 0, 2, 3, 4, 5))).toBe(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)).toLocaleString())
  })

  it('renders absent, zero and invalid timestamps as an em dash', () => {
    expect(formatTimestamp(undefined)).toBe('—')
    expect(formatTimestamp(0)).toBe('—')
    expect(formatTimestamp(Number.NaN)).toBe('—')
  })
})
