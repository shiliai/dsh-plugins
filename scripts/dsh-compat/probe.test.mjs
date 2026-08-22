import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertIsolated, validateCommit, validateVersion } from './probe.mjs'

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
