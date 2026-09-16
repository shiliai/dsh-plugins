import { existsSync, statSync } from 'node:fs'
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

const result = spawnSync(process.env.npm_execpath || 'pnpm', ['run', 'build'], {
  cwd: coreRoot,
  stdio: 'inherit',
})

if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
