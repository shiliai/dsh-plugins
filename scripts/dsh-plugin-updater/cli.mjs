#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const plugins = [
  { name: '@dsh-plugins/dsh-obsidian', directory: 'plugins/dsh-obsidian' },
  { name: '@dsh-plugins/dsh-remote', directory: 'plugins/dsh-remote' },
]
const manifestBase = process.env.DSH_PLUGIN_UPDATE_MANIFEST_BASE
  ?? 'https://raw.githubusercontent.com/shiliai/dsh-plugins/main'
const sourceBase = process.env.DSH_PLUGIN_UPDATE_SOURCE_BASE
  ?? 'github:shiliai/dsh-plugins#path:'
const buildRepositories = process.env.DSH_PLUGIN_UPDATE_BUILD_REPOSITORY
  ? [process.env.DSH_PLUGIN_UPDATE_BUILD_REPOSITORY]
  : [
      'git+https://github.com/shiliai/dsh-plugins.git',
      'git+ssh://git@github.com/shiliai/dsh-plugins.git',
    ]
const profileDir = process.cwd()

function usage(message) {
  if (message) process.stderr.write(`${message}\n\n`)
  process.stderr.write('usage: dsh-plugins-update <check|update> [package ...] [--json]\n')
  process.exit(message ? 2 : 0)
}

function parseVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value)
  if (!match) throw new Error(`invalid plugin SemVer: ${value}`)
  return [...match.slice(1, 4).map(Number), match[4] ?? null]
}

function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1
  }
  if (a[3] === b[3]) return 0
  if (a[3] === null) return 1
  if (b[3] === null) return -1
  return a[3].localeCompare(b[3], 'en', { numeric: true })
}

function packagePath(name) {
  return join(profileDir, 'node_modules', ...name.split('/'))
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function latestManifest(plugin) {
  const response = await fetch(`${manifestBase}/${plugin.directory}/package.json`, {
    headers: { accept: 'application/vnd.github.raw+json' },
  })
  if (!response.ok) {
    throw new Error(`cannot read ${plugin.name} release manifest: HTTP ${response.status}`)
  }
  const manifest = await response.json()
  if (manifest.name !== plugin.name) throw new Error(`release manifest name mismatch for ${plugin.name}`)
  parseVersion(manifest.version)
  return manifest
}

function tracksGitHubSource(spec, plugin) {
  if (typeof spec !== 'string') return false
  const repository = sourceBase.split('#', 1)[0]
  return spec.includes(repository) && spec.includes(`path:/${plugin.directory}`)
}

async function inspect(plugin, profileManifest) {
  const spec = profileManifest.dependencies?.[plugin.name]
  if (spec === undefined) return { ...plugin, status: 'not-installed' }
  let installed
  try {
    installed = await readJson(join(packagePath(plugin.name), 'package.json'))
  } catch {
    throw new Error(`${plugin.name} is declared but its installed manifest is missing`)
  }
  const latest = await latestManifest(plugin)
  const comparison = compareVersions(installed.version, latest.version)
  if (comparison > 0) throw new Error(`${plugin.name} ${installed.version} is newer than GitHub ${latest.version}`)
  const migrationRequired = !tracksGitHubSource(spec, plugin)
  return {
    ...plugin,
    installed: installed.version,
    latest: latest.version,
    source: spec,
    status: comparison < 0 ? 'outdated' : migrationRequired ? 'migration-required' : 'current',
    migrationRequired,
  }
}

function pnpm(args, capture = false) {
  return execFileSync('pnpm', args, {
    cwd: profileDir,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
}

function configureBuildTrust(selected) {
  const output = pnpm(['config', 'get', '--json', 'allowBuilds'], true).trim()
  const allowBuilds = output && output !== 'undefined' && output !== 'null'
    ? JSON.parse(output)
    : {}
  if (typeof allowBuilds !== 'object' || Array.isArray(allowBuilds)) {
    throw new Error('profile allowBuilds must be an object')
  }
  for (const plugin of selected) {
    for (const repository of buildRepositories) allowBuilds[`${plugin.name}@${repository}`] = true
  }
  pnpm(['config', 'set', '--location=project', '--json', 'allowBuilds', JSON.stringify(allowBuilds)])
}

function sourceSpec(plugin) {
  return `${sourceBase}/${plugin.directory}`
}

const [command, ...rest] = process.argv.slice(2)
if (command === '--help' || command === '-h') usage()
if (!['check', 'update'].includes(command)) usage('command must be check or update')
const json = rest.includes('--json')
const requested = rest.filter((argument) => argument !== '--json')
const unknown = requested.filter((name) => !plugins.some((plugin) => plugin.name === name))
if (unknown.length) usage(`unknown plugin: ${unknown.join(', ')}`)
const selected = requested.length ? plugins.filter((plugin) => requested.includes(plugin.name)) : plugins
const profileManifest = await readJson(join(profileDir, 'package.json'))
let results = await Promise.all(selected.map((plugin) => inspect(plugin, profileManifest)))

if (command === 'update') {
  const candidates = results.filter((result) => ['outdated', 'migration-required'].includes(result.status))
  if (candidates.length) {
    configureBuildTrust(candidates)
    for (const plugin of candidates) pnpm(['add', sourceSpec(plugin)])
    const updatedProfile = await readJson(join(profileDir, 'package.json'))
    results = await Promise.all(selected.map((plugin) => inspect(plugin, updatedProfile)))
    const incomplete = results.filter((result) => !['current', 'not-installed'].includes(result.status))
    if (incomplete.length) throw new Error(`update did not converge: ${incomplete.map((item) => item.name).join(', ')}`)
  }
}

if (json) {
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)
} else {
  for (const result of results) {
    if (result.status === 'not-installed') {
      process.stdout.write(`${result.name}: not installed\n`)
    } else {
      process.stdout.write(`${result.name}: ${result.installed} -> ${result.latest} (${result.status})\n`)
    }
  }
}
