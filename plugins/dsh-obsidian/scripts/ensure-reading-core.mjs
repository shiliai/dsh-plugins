import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const candidates = [
  resolve(pluginRoot, '../../packages/dsh-reading-core'),
  resolve(pluginRoot, 'node_modules/@dsh-plugins/dsh-reading-core'),
  resolve(pluginRoot, '../../node_modules/@dsh-plugins/dsh-reading-core'),
]

const coreRoot = candidates.find((candidate) => existsSync(join(candidate, 'package.json')))
if (!coreRoot || !statSync(coreRoot).isDirectory()) process.exit(0)

const lockPath = join(coreRoot, '.dsh-reading-core-build.lock')
const lockDeadline = Date.now() + 120_000
let locked = false
while (!locked) {
  try {
    mkdirSync(lockPath)
    locked = true
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    if (Date.now() >= lockDeadline) throw new Error(`timed out waiting for ${lockPath}`)
    // The build is short, but yielding avoids a busy loop while another
    // plugin's prebuild owns the shared core output directory.
    await new Promise(resolveSleep => setTimeout(resolveSleep, 50))
  }
}

try {
  const result = spawnSync(process.env.npm_execpath || 'pnpm', ['run', 'build'], {
    cwd: coreRoot,
    stdio: 'inherit',
  })

  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`shared core build exited with status ${result.status ?? 'unknown'}`)
} finally {
  rmSync(lockPath, { recursive: true, force: true })
}
