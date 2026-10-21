import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import type { VaultEntryKind, VaultOpener } from './contracts.ts'
import { VaultError } from './vault-service.ts'

/**
 * One application offered by the vault browser's "Open with" menu.
 *
 * The catalog is fixed on purpose: the host resolves these candidates against
 * its own filesystem and launches one of them, so a browser that can reach the
 * HTTP API can never name an arbitrary executable. Add an app by extending the
 * catalog, not by editing a DSH profile.
 */
interface AppCandidate {
  id: string
  label: string
  /** Entry kinds this app can accept (a markdown editor takes no directory). */
  kinds: VaultEntryKind[]
  darwin?: string[]
  win32?: string[]
  linux?: string[]
}

/** `${HOME}` and `%NAME%` placeholders are expanded before an existence check. */
const APP_CATALOG: AppCandidate[] = [
  {
    id: 'obsidian', label: 'Obsidian', kinds: ['note'],
    darwin: ['${HOME}/Applications/Obsidian.app', '/Applications/Obsidian.app'],
    win32: ['%LOCALAPPDATA%/Obsidian/Obsidian.exe', '%PROGRAMFILES%/Obsidian/Obsidian.exe'],
    linux: ['/usr/bin/obsidian', '/opt/Obsidian/obsidian'],
  },
  {
    id: 'vscode', label: 'Visual Studio Code', kinds: ['note', 'directory'],
    darwin: ['/Applications/Visual Studio Code.app', '${HOME}/Applications/Visual Studio Code.app'],
    win32: ['%LOCALAPPDATA%/Programs/Microsoft VS Code/Code.exe', '%PROGRAMFILES%/Microsoft VS Code/Code.exe'],
    linux: ['/usr/bin/code', '/snap/bin/code'],
  },
  {
    id: 'cursor', label: 'Cursor', kinds: ['note', 'directory'],
    darwin: ['/Applications/Cursor.app', '${HOME}/Applications/Cursor.app'],
    win32: ['%LOCALAPPDATA%/Programs/cursor/Cursor.exe'],
    linux: ['/usr/bin/cursor'],
  },
  {
    id: 'zed', label: 'Zed', kinds: ['note', 'directory'],
    darwin: ['/Applications/Zed.app'],
    linux: ['/usr/bin/zed', '/usr/local/bin/zed'],
  },
  {
    id: 'sublime', label: 'Sublime Text', kinds: ['note'],
    darwin: ['/Applications/Sublime Text.app'],
    win32: ['%PROGRAMFILES%/Sublime Text/sublime_text.exe'],
    linux: ['/usr/bin/subl'],
  },
  {
    id: 'typora', label: 'Typora', kinds: ['note'],
    darwin: ['/Applications/Typora.app'],
    win32: ['%LOCALAPPDATA%/Programs/Typora/Typora.exe'],
    linux: ['/usr/bin/typora'],
  },
  {
    id: 'macdown', label: 'MacDown', kinds: ['note'],
    darwin: ['/Applications/MacDown.app'],
  },
  {
    id: 'iawriter', label: 'iA Writer', kinds: ['note'],
    darwin: ['/Applications/iA Writer.app'],
  },
  {
    id: 'bbedit', label: 'BBEdit', kinds: ['note'],
    darwin: ['/Applications/BBEdit.app'],
  },
  {
    id: 'textedit', label: 'TextEdit', kinds: ['note'],
    darwin: ['/System/Applications/TextEdit.app', '/Applications/TextEdit.app'],
  },
  {
    id: 'notepad', label: 'Notepad', kinds: ['note'],
    win32: ['%WINDIR%/notepad.exe'],
  },
]

export type OpenerPlatform = NodeJS.Platform

/** One vault entry handed to the opener layer; its path is already canonical. */
export interface OpenerEntry {
  absolutePath: string
  kind: VaultEntryKind
}

/**
 * Seams for deterministic tests: the platform, the executable runner, the
 * existence probe, the home directory and the environment.
 */
export interface OpenerInternals {
  platform?: OpenerPlatform
  homedir?: string
  env?: NodeJS.ProcessEnv
  exists?(candidate: string): Promise<boolean>
  run?(command: string, args: string[], timeoutMs: number): Promise<void>
}

interface ResolvedApp {
  id: string
  label: string
  appPath: string
}

const DEFAULT_OPENER_ID = 'default'
const OPEN_TIMEOUT_MS = 20_000

/**
 * List what can open `entry` here: the operating system's default handler plus
 * every catalog app installed on this host. A host without a reachable desktop
 * (a headless Linux server, for example) offers the catalog apps only.
 */
export async function listOpeners(entry: OpenerEntry, internals: OpenerInternals = {}): Promise<VaultOpener[]> {
  const platform = internals.platform ?? process.platform
  const openers: VaultOpener[] = canOpenDefault(platform, internals.env ?? process.env)
    ? [{ id: DEFAULT_OPENER_ID, label: defaultOpenerLabel(platform), default: true }]
    : []
  for (const app of await resolveApps(entry.kind, internals)) openers.push({ id: app.id, label: app.label })
  return openers
}

/**
 * Label for the host desktop's "reveal in the file manager" action, or
 * `undefined` when the platform has no reachable desktop to reveal in.
 */
export function revealActionLabel(internals: OpenerInternals = {}): string | undefined {
  const platform = internals.platform ?? process.platform
  if (!canOpenDefault(platform, internals.env ?? process.env)) return undefined
  if (platform === 'darwin') return 'Reveal in Finder'
  if (platform === 'win32') return 'Reveal in File Explorer'
  return 'Show in file manager'
}

/**
 * Show `entry` in the host desktop's file manager, selecting it where the
 * platform supports that (Finder, Explorer). Linux opens the containing
 * folder instead.
 *
 * @throws {VaultError} `OPEN_UNSUPPORTED` without a desktop, `REVEAL_FAILED`
 * when the launcher itself failed.
 */
export async function revealEntry(entry: OpenerEntry, internals: OpenerInternals = {}): Promise<void> {
  const platform = internals.platform ?? process.platform
  if (revealActionLabel(internals) === undefined) {
    throw new VaultError(`Revealing entries is not supported on ${platform}.`, 'OPEN_UNSUPPORTED', 400)
  }
  const { command, args } = revealCommand(platform, entry.absolutePath, entry.kind)
  const run = internals.run ?? runCommand
  try {
    await run(command, args, OPEN_TIMEOUT_MS)
  } catch (error) {
    throw new VaultError(`Could not reveal the entry: ${message(error)}`, 'REVEAL_FAILED', 500)
  }
}

/**
 * The exact argv used to reveal a path. Pure so every platform can be tested
 * from any host.
 */
export function revealCommand(platform: OpenerPlatform, absolutePath: string, kind: VaultEntryKind): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'open', args: ['-R', absolutePath] }
  if (platform === 'win32') return { command: 'explorer.exe', args: [`/select,${absolutePath}`] }
  if (platform === 'linux') {
    // No portable "select" flag exists; the containing folder is as close as
    // xdg-open gets, and a directory is already its own container.
    return { command: 'xdg-open', args: [kind === 'directory' ? absolutePath : dirname(absolutePath)] }
  }
  throw new VaultError(`Revealing entries is not supported on ${platform}.`, 'OPEN_UNSUPPORTED', 400)
}

/**
 * Hand `entry` to `openerId` (or the default handler when omitted).
 *
 * @throws {VaultError} `UNKNOWN_OPENER` when the id is not offered for this
 * entry, `OPEN_UNSUPPORTED` on a platform without a desktop opener, and
 * `OPEN_FAILED` when the launcher itself failed.
 */
export async function openWith(entry: OpenerEntry, openerId: string | undefined, internals: OpenerInternals = {}): Promise<void> {
  const platform = internals.platform ?? process.platform
  const app = openerId === undefined || openerId === DEFAULT_OPENER_ID
    ? undefined
    : (await resolveApps(entry.kind, internals)).find(candidate => candidate.id === openerId)
  if (openerId !== undefined && openerId !== DEFAULT_OPENER_ID && app === undefined) {
    throw new VaultError(`Unknown opener for this entry: ${openerId}`, 'UNKNOWN_OPENER', 400)
  }
  const { command, args } = openerCommand(platform, entry.absolutePath, app?.appPath)
  const run = internals.run ?? runCommand
  try {
    await run(command, args, OPEN_TIMEOUT_MS)
  } catch (error) {
    throw new VaultError(`Could not open the entry: ${message(error)}`, 'OPEN_FAILED', 500)
  }
}

/**
 * The exact argv used to open a path. Pure so every platform can be tested
 * from any host: macOS and Windows go through the operating system launcher
 * (which is what "open with <app>" means there), Linux executes the selected
 * binary directly.
 */
export function openerCommand(platform: OpenerPlatform, absolutePath: string, appPath?: string): { command: string; args: string[] } {
  if (platform === 'darwin') {
    return appPath === undefined
      ? { command: 'open', args: [absolutePath] }
      : { command: 'open', args: ['-a', appPath, absolutePath] }
  }
  if (platform === 'win32') {
    const script = appPath === undefined
      ? `Invoke-Item -LiteralPath ${powershellLiteral(absolutePath)}`
      : `Start-Process -FilePath ${powershellLiteral(appPath)} -ArgumentList ${powershellLiteral(`"${absolutePath}"`)}`
    return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script] }
  }
  if (platform === 'linux') {
    return appPath === undefined
      ? { command: 'xdg-open', args: [absolutePath] }
      : { command: appPath, args: [absolutePath] }
  }
  throw new VaultError(`Opening entries is not supported on ${platform}.`, 'OPEN_UNSUPPORTED', 400)
}

/** Resolve the catalog down to apps installed here that accept `kind`. */
async function resolveApps(kind: VaultEntryKind, internals: OpenerInternals): Promise<ResolvedApp[]> {
  const platform = internals.platform ?? process.platform
  const exists = internals.exists ?? pathExists
  const apps: ResolvedApp[] = []
  for (const candidate of APP_CATALOG) {
    if (!candidate.kinds.includes(kind)) continue
    const appPath = await firstExisting(candidatePaths(candidate, platform, internals), exists)
    if (appPath !== undefined) apps.push({ id: candidate.id, label: candidate.label, appPath })
  }
  return apps
}

async function firstExisting(candidates: string[], exists: (candidate: string) => Promise<boolean>): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate
  }
  return undefined
}

function candidatePaths(candidate: AppCandidate, platform: OpenerPlatform, internals: OpenerInternals): string[] {
  const paths = platform === 'darwin' ? candidate.darwin : platform === 'win32' ? candidate.win32 : platform === 'linux' ? candidate.linux : undefined
  if (paths === undefined) return []
  const env = internals.env ?? process.env
  const home = internals.homedir ?? homedir()
  const expanded = paths.map(path => path
    .replaceAll('${HOME}', home)
    .replaceAll('%PROGRAMFILES%', env.PROGRAMFILES ?? 'C:\\Program Files')
    .replaceAll('%LOCALAPPDATA%', env.LOCALAPPDATA ?? `${home}\\AppData\\Local`)
    .replaceAll('%WINDIR%', env.WINDIR ?? 'C:\\Windows'))
  // Catalog entries are written with `/` for readability; a Windows probe and
  // launch wants native separators.
  return platform === 'win32' ? expanded.map(path => path.replaceAll('/', '\\')) : expanded
}

function defaultOpenerLabel(platform: OpenerPlatform): string {
  return platform === 'darwin' || platform === 'win32' ? 'Default app' : 'Default application'
}

/**
 * Whether handing a path to the operating system can reach a desktop. macOS and
 * Windows always can; Linux only under WSL or with a display server announced.
 */
function canOpenDefault(platform: OpenerPlatform, env: NodeJS.ProcessEnv): boolean {
  if (platform === 'darwin' || platform === 'win32') return true
  if (platform !== 'linux') return false
  const present = (value: string | undefined): boolean => value !== undefined && value !== ''
  return present(env.WSL_DISTRO_NAME) || present(env.WSL_INTEROP)
    || present(env.DISPLAY) || present(env.WAYLAND_DISPLAY)
}

/** PowerShell single-quoted literal: embedded single quotes are doubled. */
function powershellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate)
    return true
  } catch (error) {
    if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false
    throw error
  }
}

/**
 * Shell-free launcher. `open` and `xdg-open` hand the entry to a long-running
 * desktop app, so a timeout kill means the hand-off succeeded rather than
 * failed: only a real exit with an error is reported.
 */
function runCommand(command: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true }, (error, _stdout, stderr) => {
      if (error === null) { resolve(); return }
      if (isKilled(error)) { resolve(); return }
      const detail = typeof stderr === 'string' ? stderr.trim() : ''
      reject(detail === '' ? error : new Error(`${error.message} (${detail})`))
    })
  })
}

function isKilled(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { killed?: unknown }).killed === true
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
