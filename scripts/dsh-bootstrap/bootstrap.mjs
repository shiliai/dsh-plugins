#!/usr/bin/env node
/**
 * dsh-bootstrap — guided, idempotent setup for DeepSeek Harness across machines.
 *
 * Solves the "install DSH, then replicate model config + install plugins on many
 * machines (macOS / Linux / Windows)" problem. Safe to run repeatedly.
 *
 * What it does (each phase is skippable):
 *   1. ensure-dsh    Install the DSH CLI itself if it is missing.
 *   2. settings      Symlink a portable settings.yaml into $DSH_HOME so model
 *                    config (context window, multimodal, thinking effort) stays
 *                    single-source and syncs on `git pull`.
 *   3. credentials   Prompt once per machine for the api keys referenced by
 *                    settings.yaml and write them to $DSH_HOME/.credentials.yaml
 *                    (never committed, chmod 600).
 *   4. plugins       Let you choose optional plugins (required ones auto-include)
 *                    and install them through `dsh plugin`.
 *   5. update        Update DSH, the repo plugins, and npm-sourced plugins.
 *
 * Per-machine bits (cordis.patch.yml) and secrets are intentionally NOT synced.
 *
 * Usage:
 *   node bootstrap.mjs                 guided setup
 *   node bootstrap.mjs check           dry-run: print the plan, change nothing
 *   node bootstrap.mjs update          update DSH + installed plugins
 *   node bootstrap.mjs --help
 */
import { execFileSync, execSync } from 'node:child_process'
import { stdin as input, stdout as output } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, lstatSync, realpathSync, chmodSync, copyFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, isAbsolute, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const DSH_HOME_ENV = 'DSH_HOME'
// When true (--yes / non-interactive), every yes/no prompt returns its default
// and optional-plugin selection installs all optionals. Nothing surprising is
// done: steps that default to "no" (e.g. re-running a global `npm install -g`)
// stay off.
let YIELD = false
const CREDENTIALS_FILENAME = '.credentials.yaml'
const SETTINGS_FILENAME = 'settings.yaml'
const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'

// ---------------------------------------------------------------------------
// CLI / config
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    command: 'sync',
    profile: null,
    config: join(SCRIPT_DIR, 'bootstrap.config.json'),
    settings: null,
    rekey: false,
    yes: false,
    skip: new Set(),
    plugins: null, // comma-separated ids
  }
  const args = [...argv]
  while (args.length) {
    const a = args.shift()
    switch (a) {
      case '--help': case '-h': return { ...opts, command: 'help' }
      case 'check': case 'sync': case 'update': opts.command = a; break
      case '--profile': opts.profile = args.shift() ?? ''; break
      case '--config': opts.config = args.shift() ?? ''; break
      case '--settings': opts.settings = args.shift() ?? ''; break
      case '--rekey': opts.rekey = true; break
      case '--yes': opts.yes = true; break
      case '--plugins': opts.plugins = args.shift() ?? ''; break
      default:
        if (a.startsWith('--skip-')) opts.skip.add(a.slice('--skip-'.length))
        else { opts.error = `unknown argument: ${a}` }
    }
  }
  return opts
}

function resolveDshHome() {
  const fromEnv = process.env[DSH_HOME_ENV]
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  return join(homedir(), '.dsh')
}

async function loadConfig(path) {
  const raw = await readFileSync(path, 'utf8')
  const cfg = JSON.parse(raw)
  if (!Array.isArray(cfg.plugins)) throw new Error(`config ${path}: missing "plugins" array`)
  return cfg
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sh(cmd, { cwd, allowFail = false } = {}) {
  try {
    return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (err) {
    if (allowFail) return ''
    const detail = (err.stderr ?? '').toString().trim() || (err.message ?? '')
    throw new Error(`command failed: ${cmd}\n${detail}`)
  }
}

function commandExists(cmd) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function dshVersion() {
  try {
    return execSync('dsh --version', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

const TTY = !!(process.stdin.isTTY && process.stdout.isTTY)
const rl = TTY ? createInterface({ input, output, terminal: true }) : null
// In non-TTY mode (piped/redirected stdin) readline/promises only answers the
// first question, so we preload stdin as a line queue and serve from it.
const pipedLines = TTY ? null : readFileSync(0, 'utf8').split(/\r?\n/)
let pipeIdx = 0

function vaultedLine(prompt, { hidden = false } = {}) {
  if (!TTY) {
    const v = pipeIdx < pipedLines.length ? pipedLines[pipeIdx++] : ''
    return Promise.resolve(v)
  }
  if (!hidden) {
    return rl.question(`${prompt} `).then((s) => s.trim())
  }
  process.stdout.write(`${prompt} `)
  const origWrite = output.write.bind(output)
  let hiding = false
  output.write = (chunk, ...rest) => {
    const s = String(chunk)
    return (hiding && s !== '\r' && s !== '\n') ? true : origWrite(chunk, ...rest)
  }
  hiding = true
  return rl.question('').then((s) => {
    hiding = false
    output.write = origWrite
    process.stdout.write('\n')
    return s.trim()
  })
}

async function ask(q, { def = null } = {}) {
  const suffix = def !== null ? ` [${def}]` : ''
  for (;;) {
    const raw = await vaultedLine(`  ${q}${suffix}`)
    if (raw.trim() === '' && def !== null) return def
    if (raw.trim() !== '') return raw.trim()
    if (def !== null && raw.trim() === '') return def
  }
}

async function questionHidden(q) {
  return vaultedLine(`  ${q} (blank to skip)`, { hidden: true })
}

async function askYesNo(q, def = true) {
  if (YIELD) return def
  const label = def ? 'Y/n' : 'y/N'
  const raw = await vaultedLine(`  ${q} [${label}]`)
  if (raw.trim() === '') return def
  return /^y(es)?$/i.test(raw.trim())
}

async function multiSelect(title, items) {
  // items: [{ id, name, selected }]. Mutates `selected`.
  console.log(`\n${title}`)
  for (;;) {
    items.forEach((it, i) => {
      console.log(`    ${it.selected ? '[x]' : '[ ]'} ${i + 1}. ${it.name}`)
    })
    const raw = await vaultedLine('  Toggle by number (1-9, space separated) or Enter to confirm')
    if (raw.trim() === '') break
    for (const tok of raw.split(/[\s,]+/)) {
      if (tok.startsWith('!')) {
        const idx = Number(tok.slice(1)) - 1
        if (items[idx]) items[idx].selected = false
      } else {
        const idx = Number(tok) - 1
        if (items[idx]) items[idx].selected = true
      }
    }
  }
  return items.filter((it) => it.selected)
}

function log(phase, msg) {
  console.log(`[${phase}] ${msg}`)
}

function warn(msg) {
  console.log(`  ⚠ ${msg}`)
}

// ---------------------------------------------------------------------------
// Phase 1: ensure dsh is installed
// ---------------------------------------------------------------------------

async function ensureDsh(opts) {
  const existing = dshVersion()
  if (existing) {
    log('dsh', `already installed: v${existing}`)
    return existing
  }
  log('dsh', 'not found on PATH')
  if (opts.command === 'check') {
    warn('dsh would be installed via: ' + opts.configObj.dshInstallCommand)
    return null
  }
  const cmd = opts.configObj.dshInstallCommand
  const doInstall = await askYesNo(`Install DSH now? (${cmd})`)
  if (!doInstall) {
    warn('skipping DSH install; later phases that need dsh will fail')
    return null
  }
  console.log(`  running: ${cmd}`)
  try {
    execSync(cmd, { stdio: 'inherit', env: process.env })
  } catch {
    warn(`install failed — run it manually then re-run this script:\n    ${cmd}`)
    return null
  }
  return dshVersion()
}

// ---------------------------------------------------------------------------
// Phase 2: symlink portable settings.yaml
// ---------------------------------------------------------------------------

function settingsSourcePath(opts) {
  if (opts.settings) return isAbsolute(opts.settings) ? opts.settings : resolve(process.cwd(), opts.settings)
  return join(SCRIPT_DIR, opts.configObj.settingsSource)
}

function linkIsTo(target, source) {
  try {
    if (!lstatSync(target).isSymbolicLink()) return false
    return resolve(realpathSync(target)) === resolve(realpathSync(source))
  } catch {
    return false
  }
}

async function installSettings(opts) {
  const source = settingsSourcePath(opts)
  if (!existsSync(source)) {
    warn(`settings source not found: ${source}`)
    return false
  }
  const dshHome = opts.dshHome
  const target = join(dshHome, SETTINGS_FILENAME)
  mkdirSync(dshHome, { recursive: true })

  if (existsSync(target) && linkIsTo(target, source)) {
    log('settings', `already symlinked to ${source}`)
    return true
  }

  if (opts.command === 'check') {
    log('settings', `would symlink ${source} -> ${target}`)
    return true
  }

  // The target already holds a real config that is not our symlink. Replacing
  // it is destructive, so require explicit confirmation (default: no, and
  // --yes keeps that default). Nothing is lost either way: we back it up.
  if (existsSync(target) && !lstatSync(target).isSymbolicLink()) {
    const ok = await askYesNo(
      `Existing real config at ${target} — replace it with a symlink to ${basename(source)}?\n` +
      '  (the old file is backed up as settings.yaml.bak-<ts>; use --settings <your real file> if this is wrong)',
      false,
    )
    if (!ok) {
      warn(`leaving existing ${target} untouched`)
      return false
    }
    const backup = `${target}.bak-${Date.now()}`
    copyFileSync(target, backup)
    log('settings', `backed up existing file to ${backup}`)
    rmIfExists(target)
  } else if (existsSync(target)) {
    // stale symlink to somewhere else — remove it
    rmIfExists(target)
  }

  try {
    symlinkSync(source, target)
    log('settings', `symlinked ${source} -> ${target}`)
  } catch (err) {
    // Symlinks need privilege on some Windows setups — fall back to copying.
    warn(`symlink failed (${err.message}); copying instead. Re-run after syncing the repo to re-sync.`)
    copyFileSync(source, target)
  }
  return true
}

function rmIfExists(p) {
  try { rmSync(p) } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Phase 3: credentials
// ---------------------------------------------------------------------------

function referencedApiKeys(settingsPath) {
  if (!existsSync(settingsPath)) return []
  const text = readFileSync(settingsPath, 'utf8')
  const keys = new Set()
  const re = /apiKeyEnv:\s*([A-Za-z0-9_]+)/g
  let m
  while ((m = re.exec(text))) keys.add(m[1])
  return [...keys]
}

function parseCredentialsYaml(path) {
  // Minimal YAML reader for the flat `refs:` map DSH uses. Enough for our own file.
  const out = {}
  if (!existsSync(path)) return out
  const lines = readFileSync(path, 'utf8').split('\n')
  let inRefs = false
  for (const line of lines) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue }
    if (inRefs && /^\S/.test(line)) inRefs = false
    if (inRefs) {
      const m = /^\s+([A-Za-z0-9_]+):\s*(.*)$/.exec(line)
      if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
    }
  }
  return out
}

function serializeCredentialsYaml(refs) {
  const lines = ['version: 1', 'refs:']
  for (const [k, v] of Object.entries(refs)) {
    lines.push(`  ${k}: '${String(v).replace(/'/g, "''")}'`)
  }
  return lines.join('\n') + '\n'
}

async function ensureCredentials(opts) {
  const source = settingsSourcePath(opts)
  const keys = referencedApiKeys(source)
  if (!keys.length) {
    log('credentials', 'no apiKeyEnv references in settings.yaml — nothing to do')
    return
  }
  const credPath = join(opts.dshHome, CREDENTIALS_FILENAME)
  const refs = parseCredentialsYaml(credPath)
  const missing = keys.filter((k) => !refs[k])

  if (!missing.length && !opts.rekey) {
    log('credentials', `already present for: ${keys.join(', ')}`)
    return
  }
  log('credentials', `api keys needed per settings.yaml: ${missing.length ? keys.join(', ') : ''}`)

  const touch = []
  if (opts.command === 'check') {
    log('credentials', `would prompt for/keep: ${missing.join(', ') || '(none)'} -> ${credPath}`)
    return
  }
  if (!missing.length) {
    log('credentials', 'all keys present')
    return
  }

  console.log('\n  Enter API keys for each provider. You can:')
  console.log('    - paste the key directly, or')
  console.log('    - type "env:VAR_NAME" to pull the value from an environment variable, or')
  console.log('    - leave blank to skip this key (already-stored keys are kept).')
  for (const k of missing) {
    let val = null
    if (opts.yes) {
      warn(`skipping ${k} in --yes mode (no stored value)`)
      continue
    }
    if (process.env[k]) {
      const use = await askYesNo(`Use $${k} from environment for '${k}'?`, true)
      if (use) { val = process.env[k]; touch.push(k) }
      else { const v = await questionHidden(`  Enter value for '${k}' (blank to skip): `); if (v) { val = v; touch.push(k) } }
    } else {
      const v = await questionHidden(`  Enter value for '${k}' (blank to skip): `)
      if (v.startsWith('env:')) {
        const envName = v.slice(4).trim()
        if (process.env[envName]) { val = process.env[envName]; touch.push(k) }
        else warn(`env var ${envName} not set; skipping ${k}`)
      } else if (v) {
        val = v
        touch.push(k)
      }
    }
    if (val !== null) refs[k] = val
  }

  if (!touch.length) {
    warn('nothing new to write; leaving credentials untouched')
    return
  }
  writeFileSync(credPath, serializeCredentialsYaml(refs))
  try { chmodSync(credPath, 0o600) } catch { /* best-effort on Windows */ }
  console.log(`  wrote ${credPath} (permissions 600)` +
    '\n  ⚠ Do NOT commit this file — it holds secrets and is machine-local by design.')
}

// ---------------------------------------------------------------------------
// Phase 4: plugins
// ---------------------------------------------------------------------------

function profileDir(opts) {
  return join(opts.dshHome, 'profiles', opts.profile)
}

function installedPackageNames(opts) {
  const pkg = join(profileDir(opts), 'package.json')
  if (!existsSync(pkg)) return new Set()
  try {
    const data = JSON.parse(readFileSync(pkg, 'utf8'))
    return new Set(Object.keys(data.dependencies ?? {}))
  } catch {
    return new Set()
  }
}

function readAllowBuilds(opts) {
  // Read the profile's build-trust map (pnpm-workspace.yaml) so we merge, not clobber.
  const p = join(profileDir(opts), 'pnpm-workspace.yaml')
  const out = {}
  if (!existsSync(p)) return out
  let inAllow = false
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (/^allowBuilds:\s*$/.test(line)) { inAllow = true; continue }
    if (inAllow) {
      if (/^\S/.test(line)) break
      const m = /^\s*['"]?([^'"\s][^:]*?)['"]?\s*:\s*(true|false)\s*$/.exec(line)
      if (m) out[m[1].trim()] = m[2] === 'true'
    }
  }
  return out
}

function runDshPlugin(opts, args, { allowFail = false } = {}) {
  const cmd = `dsh plugin --profile "${opts.profile}" ${args.join(' ')}`
  try {
    return execSync(cmd, { cwd: profileDir(opts), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (err) {
    if (allowFail) return ''
    const detail = (err.stderr ?? '').toString().trim() || (err.message ?? '')
    throw new Error(`command failed: ${cmd}\n${detail}`)
  }
}

function ensureBuildTrust(opts) {
  const cfg = opts.configObj
  const githubPlugins = cfg.plugins.filter((p) => p.sourceType === 'github')
  if (!githubPlugins.length) return
  const existing = readAllowBuilds(opts)
  let changed = false
  for (const p of githubPlugins) {
    for (const repo of cfg.updaterRepositories) {
      const entry = `${p.package}@${repo}`
      if (!existing[entry]) { existing[entry] = true; changed = true }
    }
  }
  if (!changed) {
    log('plugins', 'build trust already configured')
    return
  }
  log('plugins', 'adding GitHub build trust for repo plugins')
  if (opts.command === 'check') {
    log('plugins', 'would set allowBuilds to cover the repo plugins')
    return
  }
  const json = JSON.stringify(existing)
  runDshPlugin(opts, ['config', 'set', '--location=project', '--json', 'allowBuilds', json])
  log('plugins', 'build trust updated')
}

async function ensurePlugins(opts) {
  const cfg = opts.configObj
  const installed = installedPackageNames(opts)

  // Build selection list: required auto-included; optional chosen interactively.
  const items = cfg.plugins.map((p) => ({
    ...p,
    selected: !!p.required || installed.has(p.package) || (opts.plugins ? opts.plugins.split(',').includes(p.id) : false),
  }))

  if (opts.command === 'sync') {
    const required = items.filter((p) => p.required)
    const optional = items.filter((p) => !p.required)
    if (required.length) {
      console.log(`\n  Required plugins (auto-install): ${required.map((p) => p.id).join(', ')}`)
    }
    if (optional.length) {
      if (!opts.yes) {
        await multiSelect('  Optional plugins — select which to install:', optional)
      } else {
        console.log('  Optional plugins (--yes: installing all): ' + optional.map((p) => p.id).join(', '))
        optional.forEach((p) => { p.selected = true })
      }
    }
  }

  const toEnsure = items.filter((p) => p.selected)
  const toInstall = toEnsure.filter((p) => !installed.has(p.package))

  ensureBuildTrust(opts)

  if (!toInstall.length) {
    log('plugins', 'all selected plugins already installed')
    return
  }
  for (const p of toInstall) {
    log('plugins', `installing ${p.id} via dsh plugin`)
    if (opts.command === 'check') {
      log('plugins', `  would run: dsh plugin --profile ${opts.profile} add ${p.spec}`)
      continue
    }
    runDshPlugin(opts, ['add', p.spec])
    console.log(`  ✓ ${p.id} installed`)
  }
  console.log('  Restart the DSH profile to pick up newly installed plugins.')
}

// ---------------------------------------------------------------------------
// Phase 5: update
// ---------------------------------------------------------------------------

async function updateAll(opts) {
  const cfg = opts.configObj
  const installed = installedPackageNames(opts)

  // Repo-sourced plugins: use the repository updater (resolves GitHub revisions).
  const githubInstalled = cfg.plugins.filter((p) => p.sourceType === 'github' && installed.has(p.package))
  if (githubInstalled.length) {
    log('update', `checking repo plugins (${githubInstalled.map((p) => p.package).join(', ')})`)
    const d = `--config.dlx-cache-max-age=0`
    const check = runDshPlugin(opts, [d, 'dlx', cfg.updaterSource, 'check'], { allowFail: true })
    console.log(check || '  up to date')
    const doUpdate = await askYesNo('Update repo plugins now?', true)
    if (doUpdate) runDshPlugin(opts, [d, 'dlx', cfg.updaterSource, 'update'])
    else log('update', 'skipped repo plugin update')
  }

  // npm-sourced plugins: bump through pnpm in the profile.
  const npmInstalled = cfg.plugins.filter((p) => p.sourceType === 'npm' && installed.has(p.package))
  if (npmInstalled.length) {
    log('update', `updating npm plugins (${npmInstalled.map((p) => p.package).join(', ')})`)
    const doUpdate = await askYesNo('Update npm plugins now?', true)
    if (doUpdate) {
      for (const p of npmInstalled) {
        runDshPlugin(opts, ['-w', 'up', p.package], { allowFail: true })
        console.log(`  ✓ ${p.id} updated`)
      }
    }
  }

  // DSH itself.
  const dshCur = dshVersion()
  if (dshCur) {
    const doUpdate = await askYesNo(`Update DSH CLI itself (current ${dshCur})?`, false)
    if (doUpdate) {
      console.log(`  running: ${cfg.dshInstallCommand}`)
      execSync(cfg.dshInstallCommand, { stdio: 'inherit' })
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.error) { console.error(`error: ${opts.error}`); usage(); process.exit(2) }
  if (opts.command === 'help' || !['sync', 'check', 'update'].includes(opts.command)) { usage(); return }

  const configObj = await loadConfig(opts.config)
  opts.configObj = configObj
  opts.profile = opts.profile || configObj.profile
  opts.dshHome = resolveDshHome()
  YIELD = opts.yes

  const BANNER = `\n  dsh-bootstrap — DeepSeek Harness setup\n  profile   : ${opts.profile}\n  DSH_HOME  : ${opts.dshHome}`
  console.log(BANNER)
  if (process.platform === 'win32') {
    warn('Windows is designed-for but not yet verified in DSH; review each step.')
  }
  if (!opts.skip.has('settings')) {
    console.log(`\n  Step: sync portable model config (${SETTINGS_FILENAME})`)
    await installSettings(opts)
  }
  if (!opts.skip.has('credentials')) {
    console.log(`\n  Step: API credentials (${CREDENTIALS_FILENAME})`)
    await ensureCredentials(opts)
  }
  if (opts.command !== 'update') {
    const dsh = opts.skip.has('dsh') ? null : (await ensureDsh(opts))
    opts.dshAvailable = !!dsh
    if (!opts.skip.has('plugins')) {
      console.log(`\n  Step: plugins`)
      if (existsSync(profileDir(opts))) await ensurePlugins(opts)
      else warn(`profile "${opts.profile}" not found under ${profileDir(opts)} — create it first (e.g. run \`dsh ${opts.profile}\` once)`)
    }
  }

  if (opts.command === 'update') {
    console.log(`\n  Step: update DSH + plugins`)
    await updateAll(opts)
  } else if (opts.command === 'sync' && (await askYesNo('\nRun updates now? (recommended on first setup)', false))) {
    await updateAll(opts)
  }

  if (opts.command === 'check') {
    console.log('\n  dry-run complete — nothing was changed.')
  } else {
    console.log(`\n  Done. Restart your DSH profile (\`dsh ${opts.profile}\`) to apply changes.\n  Re-run this whenever you want to re-check or update (it is safe to run repeatedly).`)
  }
  rl?.close()
}

function usage() {
  console.log(`usage: node bootstrap.mjs [command] [options]

commands:
  sync        (default) guided setup & optional update
  check       dry-run — print the plan, change nothing
  update      update DSH, repo plugins and npm plugins

options:
  --profile <name>     target profile (default: config "profile")
  --config <path>      plugin/manifest config JSON (default: ./bootstrap.config.json)
  --settings <path>    portable settings.yaml to symlink (default: config "settingsSource")
  --plugins <ids>      comma-separated plugin ids to install (others stay unselected)
  --rekey              force re-prompt for credential values
  --yes                non-interactive: accept defaults, install all optional plugins
  --skip-dsh           skip DSH install check
  --skip-settings      skip settings symlink
  --skip-credentials   skip credentials
  --skip-plugins       skip plugins
  -h, --help           show this help`)
}

main().catch((err) => {
  console.error(`\nerror: ${err?.message ?? err}`)
  process.exit(1)
})
