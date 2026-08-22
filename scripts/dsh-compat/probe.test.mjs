import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { assertIsolated, checkPeers, validateCommit, validateVersion } from './probe.mjs'

test('accepts the dedicated x570 compatibility ports', () => {
  assert.doesNotThrow(() => assertIsolated(3380, 30321))
})

test('rejects production and overlapping ports', () => {
  assert.throws(() => assertIsolated(3280, 30321), /overlap/u)
  assert.throws(() => assertIsolated(3380, 3380), /overlap/u)
})

test('validates immutable resolved versions', () => {
  assert.doesNotThrow(() => validateVersion('0.1.1-rc.2'))
  assert.doesNotThrow(() => validateCommit('37b8f66f9349a8d867a54a39cae43fac6ae3732c'))
  assert.throws(() => validateVersion('latest'), /invalid/u)
  assert.throws(() => validateCommit('main'), /invalid/u)
})

test('records an unsupported peer without blocking runtime tests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-compat-peers-'))
  const runtime = join(root, 'runtime')
  const installed = join(runtime, 'node_modules/.pnpm/example@2.0.0/node_modules/example')
  await mkdir(installed, { recursive: true })
  await mkdir(join(runtime, 'node_modules/semver'), { recursive: true })
  await writeFile(join(runtime, 'package.json'), '{"private":true}\n')
  await writeFile(join(installed, 'package.json'), '{"name":"example","version":"2.0.0"}\n')
  await writeFile(join(runtime, 'node_modules/semver/index.js'), 'exports.satisfies = () => false\n')
  const manifest = join(root, 'plugin.json')
  const output = join(root, 'peers.json')
  await writeFile(manifest, '{"peerDependencies":{"example":"^1.0.0"}}\n')

  const result = await checkPeers(runtime, manifest, output)

  assert.equal(result.declaredCompatible, false)
  assert.equal(JSON.parse(await readFile(output, 'utf8')).checks[0].declaredCompatible, false)
})
