import { execFile } from 'node:child_process'

const PACKAGE_NAME = '@wecom/cli'
const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u

export type CliUpdateState = 'current' | 'outdated' | 'ahead' | 'missing'

export interface CliUpdateStatus {
  installed: string | null
  latest: string
  state: CliUpdateState
  checkedAt: number
  updated: boolean
}

export type CliCommandRunner = (command: string, args: string[]) => Promise<string>

function defaultRunner(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 5 * 60_000 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

function parseVersion(value: string): [number, number, number, string[]] {
  const match = VERSION_PATTERN.exec(value)
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) throw new Error(`invalid semantic version: ${value}`)
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4]?.split('.') ?? []]
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return left.length === right.length ? 0 : left.length === 0 ? 1 : -1
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1
    if (a === b) continue
    const aNumber = /^\d+$/u.test(a)
    const bNumber = /^\d+$/u.test(b)
    if (aNumber && bNumber) return Number(a) < Number(b) ? -1 : 1
    if (aNumber !== bNumber) return aNumber ? -1 : 1
    return a < b ? -1 : 1
  }
  return 0
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return (a[index] as number) < (b[index] as number) ? -1 : 1
  }
  return comparePrerelease(a[3], b[3])
}

export function parseInstalledVersion(output: string): string {
  const match = /(?:^|\n)wecom-cli\s+(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:\s|$)/u.exec(output.trim())
  if (match?.[1] === undefined) throw new Error('wecom-cli returned an invalid version')
  parseVersion(match[1])
  return match[1].replace(/^v/u, '')
}

export function parseLatestVersion(output: string): string {
  let value: unknown
  try { value = JSON.parse(output.trim()) } catch { value = output.trim() }
  if (typeof value !== 'string') throw new Error('npm returned an invalid @wecom/cli version')
  const normalized = value.replace(/^v/u, '')
  parseVersion(normalized)
  return normalized
}

function commandMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

export class CliUpdateManager {
  private task: Promise<CliUpdateStatus> | undefined

  constructor(private readonly run: CliCommandRunner = defaultRunner) {}

  check(): Promise<CliUpdateStatus> {
    return this.schedule(() => this.readStatus(false))
  }

  update(): Promise<CliUpdateStatus> {
    return this.schedule(async () => {
      const before = await this.readStatus(false)
      if (before.state === 'current' || before.state === 'ahead') return before
      await this.run('npm', ['install', '--global', `${PACKAGE_NAME}@latest`])
      const after = await this.readStatus(true)
      if (after.state === 'missing' || after.state === 'outdated') throw new Error('wecom-cli update did not install the latest version')
      return after
    })
  }

  private schedule(operation: () => Promise<CliUpdateStatus>): Promise<CliUpdateStatus> {
    if (this.task !== undefined) return this.task
    const task = operation()
    const pending = task.finally(() => {
      if (this.task === pending) this.task = undefined
    })
    this.task = pending
    return pending
  }

  private async readStatus(updated: boolean): Promise<CliUpdateStatus> {
    const latest = parseLatestVersion(await this.run('npm', ['view', PACKAGE_NAME, 'version', '--json']))
    let installed: string | null
    try { installed = parseInstalledVersion(await this.run('wecom-cli', ['--version'])) } catch (error) {
      if (!commandMissing(error)) throw error
      installed = null
    }
    const state = installed === null ? 'missing' : compareVersions(installed, latest) < 0 ? 'outdated' : compareVersions(installed, latest) > 0 ? 'ahead' : 'current'
    return { installed, latest, state, checkedAt: Date.now(), updated }
  }
}
