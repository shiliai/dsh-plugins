import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const bootstrap = join(scriptDir, 'bootstrap.mjs')
const config = join(scriptDir, 'bootstrap.config.json')

function runBootstrap(home, settings, env) {
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
  assert.equal(result.status, 0, result.stderr)
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
    assert.match(first, /^FIXTURE_API_KEY: 'fixture-secret'$/m)
    assert.doesNotMatch(first, /^version:/m)
    assert.doesNotMatch(first, /^refs:/m)
    assert.equal(statSync(credentials).mode & 0o777, 0o600)

    writeFileSync(credentials, "version: 1\nrefs:\n  FIXTURE_API_KEY: 'legacy''secret'\n")
    chmodSync(credentials, 0o600)
    writeFileSync(settings, 'llm-pi-ai:\n  providers:\n    fixture:\n      apiKeyEnv: FIXTURE_API_KEY\n    second:\n      apiKeyEnv: SECOND_API_KEY\n')
    runBootstrap(home, settings, { SECOND_API_KEY: 'second-secret' })

    const migrated = readFileSync(credentials, 'utf8')
    assert.match(migrated, /^FIXTURE_API_KEY: 'legacy''secret'$/m)
    assert.match(migrated, /^SECOND_API_KEY: 'second-secret'$/m)
    assert.doesNotMatch(migrated, /^version:/m)
    assert.doesNotMatch(migrated, /^refs:/m)
    assert.equal(statSync(credentials).mode & 0o777, 0o600)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
