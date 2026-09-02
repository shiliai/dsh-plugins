import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { parseDocument } from 'yaml'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const bootstrap = join(scriptDir, 'bootstrap.mjs')
const config = join(scriptDir, 'bootstrap.config.json')

function invokeBootstrap(home, settings, env = {}) {
  const result = spawnSync(process.execPath, [
    bootstrap,
    'sync',
    '--config', config,
    '--settings', settings,
    '--skip-dsh',
    '--skip-settings',
    '--skip-baseurl',
    '--skip-plugins',
  ], {
    encoding: 'utf8',
    env: { ...process.env, ...env, DSH_HOME: home },
    input: '\n\n',
  })
  return result
}

function runBootstrap(home, settings, env) {
  const result = invokeBootstrap(home, settings, env)
  assert.equal(result.status, 0, result.stderr)
}

function parseCredentials(path) {
  return parseDocument(readFileSync(path, 'utf8'), { uniqueKeys: true }).toJS()
}

test('writes rc.8 flat credentials and migrates the legacy wrapper', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bootstrap-credentials-'))
  const home = join(root, 'home')
  const settings = join(root, 'settings.yaml')
  const credentials = join(home, '.credentials.yaml')

  try {
    mkdirSync(home)
    writeFileSync(settings, 'llm-pi-ai:\n  providers:\n    fixture:\n      apiKeyEnv: FIXTURE_API_KEY\n')
    runBootstrap(home, settings, { FIXTURE_API_KEY: 'fixture-secret' })

    const first = readFileSync(credentials, 'utf8')
    assert.deepEqual(parseCredentials(credentials), { FIXTURE_API_KEY: 'fixture-secret' })
    assert.doesNotMatch(first, /^version:/m)
    assert.doesNotMatch(first, /^refs:/m)
    assert.equal(statSync(credentials).mode & 0o777, 0o600)

    writeFileSync(credentials, "version: 1\nrefs:\n  FIXTURE_API_KEY: 'legacy''secret'\n")
    chmodSync(credentials, 0o600)
    writeFileSync(settings, 'llm-pi-ai:\n  providers:\n    fixture:\n      apiKeyEnv: FIXTURE_API_KEY\n    second:\n      apiKeyEnv: SECOND_API_KEY\n')
    runBootstrap(home, settings, { SECOND_API_KEY: 'second-secret' })

    const migrated = readFileSync(credentials, 'utf8')
    assert.deepEqual(parseCredentials(credentials), {
      FIXTURE_API_KEY: "legacy'secret",
      SECOND_API_KEY: 'second-secret',
    })
    assert.doesNotMatch(migrated, /^version:/m)
    assert.doesNotMatch(migrated, /^refs:/m)
    assert.equal(statSync(credentials).mode & 0o777, 0o600)
    const backups = readdirSync(home).filter((name) => name.startsWith('.credentials.yaml.legacy-'))
    assert.equal(backups.length, 1)
    assert.equal(statSync(join(home, backups[0])).mode & 0o777, 0o600)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('creates a missing DSH home with owner-only credentials', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bootstrap-new-home-'))
  const home = join(root, 'missing-home')
  const settings = join(root, 'settings.yaml')
  const credentials = join(home, '.credentials.yaml')
  try {
    writeFileSync(settings, 'llm-pi-ai:\n  providers:\n    fixture:\n      apiKeyEnv: FIXTURE_API_KEY\n')
    runBootstrap(home, settings, { FIXTURE_API_KEY: 'fixture-secret' })
    assert.equal(statSync(home).mode & 0o777, 0o700)
    assert.equal(statSync(credentials).mode & 0o777, 0o600)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('migrates an all-keys-present legacy file without prompting for a new key', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bootstrap-legacy-complete-'))
  const home = join(root, 'home')
  const settings = join(root, 'settings.yaml')
  const credentials = join(home, '.credentials.yaml')
  try {
    mkdirSync(home)
    writeFileSync(settings, 'llm-pi-ai:\n  providers:\n    fixture:\n      apiKeyEnv: FIXTURE_API_KEY\n')
    writeFileSync(credentials, "version: 1\nrefs:\n  FIXTURE_API_KEY: 'already-present'\n")
    chmodSync(credentials, 0o600)
    runBootstrap(home, settings)
    assert.deepEqual(parseCredentials(credentials), { FIXTURE_API_KEY: 'already-present' })
    assert.equal(readdirSync(home).filter((name) => name.includes('.legacy-')).length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('preserves valid rc.8 YAML formatting while adding a missing key', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bootstrap-rich-yaml-'))
  const home = join(root, 'home')
  const settings = join(root, 'settings.yaml')
  const credentials = join(home, '.credentials.yaml')
  try {
    mkdirSync(home)
    writeFileSync(settings, 'llm-pi-ai:\n  providers:\n    fixture:\n      apiKeyEnv: FIXTURE_API_KEY\n    second:\n      apiKeyEnv: SECOND_API_KEY\n')
    writeFileSync(credentials, '# keep this annotation\n"FIXTURE_API_KEY": |-\n  line one\n  line two\nCOMMENTED_KEY: stored # keep inline\n')
    chmodSync(credentials, 0o600)
    runBootstrap(home, settings, { SECOND_API_KEY: 'second-secret' })
    const raw = readFileSync(credentials, 'utf8')
    assert.match(raw, /# keep this annotation/)
    assert.match(raw, /COMMENTED_KEY: stored # keep inline/)
    assert.deepEqual(parseCredentials(credentials), {
      FIXTURE_API_KEY: 'line one\nline two',
      COMMENTED_KEY: 'stored',
      SECOND_API_KEY: 'second-secret',
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails closed without rewriting an invalid credentials document', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bootstrap-invalid-yaml-'))
  const home = join(root, 'home')
  const settings = join(root, 'settings.yaml')
  const credentials = join(home, '.credentials.yaml')
  const invalid = "FIXTURE_API_KEY: 'first'\nFIXTURE_API_KEY: 'second'\n"
  try {
    mkdirSync(home)
    writeFileSync(settings, 'llm-pi-ai:\n  providers:\n    fixture:\n      apiKeyEnv: FIXTURE_API_KEY\n')
    writeFileSync(credentials, invalid)
    chmodSync(credentials, 0o600)
    const result = invokeBootstrap(home, settings)
    assert.notEqual(result.status, 0)
    assert.equal(readFileSync(credentials, 'utf8'), invalid)
    assert.doesNotMatch(result.stderr, /first|second/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('launchers refresh cached source and install bootstrap dependencies', () => {
  const shell = readFileSync(join(scriptDir, 'setup.sh'), 'utf8')
  const powershell = readFileSync(join(scriptDir, 'setup.ps1'), 'utf8')
  for (const source of [shell, powershell]) {
    assert.match(source, /fetch --depth 1 origin main/)
    assert.match(source, /reset --hard FETCH_HEAD/)
    assert.match(source, /npm install/)
    assert.match(source, /package-lock=false/)
  }
})
