import { describe, expect, it, vi } from 'vitest'
import { listOpeners, openerCommand, openWith, revealActionLabel, revealCommand, revealEntry, type OpenerInternals } from '../src/openers.ts'

const NOTE = { absolutePath: '/vault/Notes/Today.md', kind: 'note' as const }
const DIRECTORY = { absolutePath: '/vault/Projects', kind: 'directory' as const }

/** Internals whose filesystem contains exactly `installed` (by path). */
function internals(installed: string[], overrides: Partial<OpenerInternals> = {}): OpenerInternals & { run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(async (_command: string, _args: string[], _timeoutMs: number): Promise<void> => undefined)
  return {
    platform: 'darwin',
    homedir: '/Users/tester',
    env: {},
    exists: async candidate => installed.includes(candidate),
    run,
    ...overrides,
  } as OpenerInternals & { run: ReturnType<typeof vi.fn> }
}

describe('openerCommand', () => {
  it('uses the macOS launcher with and without an explicit app', () => {
    expect(openerCommand('darwin', '/vault/Today.md')).toEqual({ command: 'open', args: ['/vault/Today.md'] })
    expect(openerCommand('darwin', '/vault/Today.md', '/Applications/Obsidian.app')).toEqual({
      command: 'open', args: ['-a', '/Applications/Obsidian.app', '/vault/Today.md'],
    })
  })

  it('uses PowerShell on Windows and doubles embedded quotes', () => {
    expect(openerCommand('win32', 'C:\\vault\\Today.md')).toEqual({
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', "Invoke-Item -LiteralPath 'C:\\vault\\Today.md'"],
    })
    expect(openerCommand('win32', "C:\\vault\\It's.md", 'C:\\Apps\\Obsidian.exe')).toEqual({
      command: 'powershell.exe',
      args: [
        '-NoProfile', '-NonInteractive', '-Command',
        `Start-Process -FilePath 'C:\\Apps\\Obsidian.exe' -ArgumentList '"C:\\vault\\It''s.md"'`,
      ],
    })
  })

  it('executes the binary directly on Linux', () => {
    expect(openerCommand('linux', '/vault/Today.md')).toEqual({ command: 'xdg-open', args: ['/vault/Today.md'] })
    expect(openerCommand('linux', '/vault/Today.md', '/usr/bin/code')).toEqual({ command: '/usr/bin/code', args: ['/vault/Today.md'] })
  })

  it('refuses platforms without a desktop opener', () => {
    expect(() => openerCommand('aix' as NodeJS.Platform, '/vault/Today.md')).toThrow(/not supported on aix/u)
  })
})

describe('listOpeners', () => {
  it('offers the default handler first, then installed apps that accept the kind', async () => {
    const openers = await listOpeners(NOTE, internals([
      '/Applications/Obsidian.app',
      '/Applications/Visual Studio Code.app',
    ]))
    expect(openers).toEqual([
      { id: 'default', label: 'Default app', default: true },
      { id: 'obsidian', label: 'Obsidian' },
      { id: 'vscode', label: 'Visual Studio Code' },
    ])
  })

  it('filters apps that cannot take a directory', async () => {
    const openers = await listOpeners(DIRECTORY, internals([
      '/Applications/Obsidian.app',
      '/Applications/Visual Studio Code.app',
    ]))
    expect(openers.map(opener => opener.id)).toEqual(['default', 'vscode'])
  })

  it('expands the home placeholder when probing candidates', async () => {
    const exists = vi.fn(async (candidate: string) => candidate === '/Users/tester/Applications/Obsidian.app')
    const openers = await listOpeners(NOTE, { platform: 'darwin', homedir: '/Users/tester', exists })
    expect(exists).toHaveBeenCalledWith('/Users/tester/Applications/Obsidian.app')
    expect(openers.map(opener => opener.id)).toEqual(['default', 'obsidian'])
  })

  it('offers no opener on a platform without a reachable desktop', async () => {
    expect(await listOpeners(NOTE, internals([], { platform: 'aix' as NodeJS.Platform }))).toEqual([])
    expect(await listOpeners(NOTE, internals([], { platform: 'linux', env: {} }))).toEqual([])
  })

  it('offers the default handler on Linux when a display server is announced', async () => {
    const openers = await listOpeners(NOTE, internals([], { platform: 'linux', env: { DISPLAY: ':0' } }))
    expect(openers).toEqual([{ id: 'default', label: 'Default application', default: true }])
  })

  it('probes Windows candidates with native separators', async () => {
    const exists = vi.fn(async (candidate: string) => candidate === 'C:\\Program Files\\Microsoft VS Code\\Code.exe')
    const openers = await listOpeners(DIRECTORY, {
      platform: 'win32',
      homedir: 'C:\\Users\\tester',
      env: { PROGRAMFILES: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' },
      exists,
    })
    expect(exists).toHaveBeenCalledWith('C:\\Program Files\\Microsoft VS Code\\Code.exe')
    expect(openers.map(opener => opener.id)).toEqual(['default', 'vscode'])
  })
})

describe('revealActionLabel', () => {
  it('names the host file manager per platform', () => {
    expect(revealActionLabel({ platform: 'darwin' })).toBe('Reveal in Finder')
    expect(revealActionLabel({ platform: 'win32' })).toBe('Reveal in File Explorer')
    expect(revealActionLabel({ platform: 'linux', env: { DISPLAY: ':0' } })).toBe('Show in file manager')
  })

  it('is unavailable without a reachable desktop', () => {
    expect(revealActionLabel({ platform: 'linux', env: {} })).toBeUndefined()
    expect(revealActionLabel({ platform: 'aix' as NodeJS.Platform })).toBeUndefined()
  })
})

describe('revealCommand', () => {
  it('selects the entry in Finder and File Explorer', () => {
    expect(revealCommand('darwin', '/vault/Notes/Today.md', 'note')).toEqual({ command: 'open', args: ['-R', '/vault/Notes/Today.md'] })
    expect(revealCommand('win32', 'C:\\vault\\Today.md', 'note')).toEqual({ command: 'explorer.exe', args: ['/select,C:\\vault\\Today.md'] })
  })

  it('opens the containing folder on Linux, and a directory itself', () => {
    expect(revealCommand('linux', '/vault/Notes/Today.md', 'note')).toEqual({ command: 'xdg-open', args: ['/vault/Notes'] })
    expect(revealCommand('linux', '/vault/Projects', 'directory')).toEqual({ command: 'xdg-open', args: ['/vault/Projects'] })
  })

  it('refuses platforms without a desktop', () => {
    expect(() => revealCommand('aix' as NodeJS.Platform, '/vault/Today.md', 'note')).toThrow(/not supported on aix/u)
  })
})

describe('revealEntry', () => {
  it('runs the platform reveal command', async () => {
    const seams = internals([])
    await revealEntry(NOTE, seams)
    expect(seams.run).toHaveBeenCalledWith('open', ['-R', '/vault/Notes/Today.md'], expect.any(Number))
  })

  it('reports an unsupported host and a launcher failure', async () => {
    await expect(revealEntry(NOTE, internals([], { platform: 'linux', env: {} })))
      .rejects.toMatchObject({ code: 'OPEN_UNSUPPORTED' })
    const failing = internals([], { run: vi.fn(async () => { throw new Error('nope') }) })
    await expect(revealEntry(NOTE, failing)).rejects.toMatchObject({ code: 'REVEAL_FAILED' })
  })
})

describe('openWith', () => {
  it('opens with the default handler when the opener is omitted', async () => {
    const seams = internals([])
    await openWith(NOTE, undefined, seams)
    expect(seams.run).toHaveBeenCalledWith('open', ['/vault/Notes/Today.md'], expect.any(Number))
  })

  it('opens with a catalog app the host resolved itself', async () => {
    const seams = internals(['/Applications/Obsidian.app'])
    await openWith(NOTE, 'obsidian', seams)
    expect(seams.run).toHaveBeenCalledWith('open', ['-a', '/Applications/Obsidian.app', '/vault/Notes/Today.md'], expect.any(Number))
  })

  it('rejects an opener id that is not offered for this entry', async () => {
    const seams = internals(['/Applications/Obsidian.app'])
    await expect(openWith(DIRECTORY, 'obsidian', seams)).rejects.toMatchObject({ code: 'UNKNOWN_OPENER' })
    await expect(openWith(NOTE, 'not-an-app', seams)).rejects.toMatchObject({ code: 'UNKNOWN_OPENER' })
    expect(seams.run).not.toHaveBeenCalled()
  })

  it('reports a launcher failure as OPEN_FAILED', async () => {
    const seams = internals(['/Applications/Obsidian.app'], { run: vi.fn(async () => { throw new Error('boom') }) })
    await expect(openWith(NOTE, 'obsidian', seams)).rejects.toMatchObject({ code: 'OPEN_FAILED', message: expect.stringContaining('boom') })
  })
})
