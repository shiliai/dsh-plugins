import { describe, expect, it } from 'vitest'
import { CONFIG_EXPORT_KIND, CONFIG_FORMAT_VERSION, buildEnvelope, ConfigPortabilityError, mergeEnvelopes, parseEnvelope } from '../src/contracts.ts'

describe('config export envelope', () => {
  it('builds a well-formed envelope with defaults', () => {
    const before = new Date().toISOString()
    const envelope = buildEnvelope({ 'dsh-reading': { displayName: 'Reading', config: { wallabag: null } } })
    expect(envelope.kind).toBe(CONFIG_EXPORT_KIND)
    expect(envelope.formatVersion).toBe(CONFIG_FORMAT_VERSION)
    expect(envelope.exportedAt >= before).toBe(true)
    expect(envelope.plugins['dsh-reading']).toEqual({ displayName: 'Reading', config: { wallabag: null } })
  })

  it('honors an explicit exportedAt and rejects malformed sections', () => {
    const envelope = buildEnvelope({ a: { displayName: 'A', config: 1 } }, '2026-01-02T03:04:05.000Z')
    expect(envelope.exportedAt).toBe('2026-01-02T03:04:05.000Z')
    expect(() => buildEnvelope({ a: { displayName: '', config: 1 } })).toThrowError(ConfigPortabilityError)
    expect(() => buildEnvelope({ a: null as never })).toThrowError(ConfigPortabilityError)
  })

  it('merges envelopes with later-wins semantics and the earliest exportedAt', () => {
    const first = buildEnvelope({ a: { displayName: 'A', config: { v: 1 } } }, '2026-01-01T00:00:00.000Z')
    const second = buildEnvelope({ a: { displayName: 'A', config: { v: 2 } }, b: { displayName: 'B', config: {} } }, '2026-06-01T00:00:00.000Z')
    const merged = mergeEnvelopes(first, second)
    expect(Object.keys(merged.plugins).sort()).toEqual(['a', 'b'])
    expect(merged.plugins.a?.config).toEqual({ v: 2 })
    expect(merged.exportedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(() => mergeEnvelopes()).toThrowError(ConfigPortabilityError)
  })

  it('parses valid envelopes and rejects kind mismatches', () => {
    const envelope = buildEnvelope({ a: { displayName: 'A', config: { x: [1, 2] } } })
    expect(parseEnvelope(JSON.parse(JSON.stringify(envelope)))).toEqual(envelope)
    expect(() => parseEnvelope({ kind: 'other', formatVersion: 1, exportedAt: 'x', plugins: {} })).toThrowError(/not a DSH config export/u)
    expect(() => parseEnvelope('nope')).toThrowError(ConfigPortabilityError)
    expect(() => parseEnvelope({ ...envelope, plugins: 'nope' })).toThrowError(/plugins/u)
    expect(() => parseEnvelope({ ...envelope, plugins: { a: { displayName: 'A' } } })).toThrowError(/malformed/u)
  })

  it('rejects newer and invalid format versions', () => {
    const envelope = buildEnvelope({ a: { displayName: 'A', config: {} } })
    expect(() => parseEnvelope({ ...envelope, formatVersion: 2 })).toThrowError(/newer than supported/u)
    expect(() => parseEnvelope({ ...envelope, formatVersion: 0 })).toThrowError(/invalid/u)
    expect(() => parseEnvelope({ ...envelope, formatVersion: '1' })).toThrowError(/invalid/u)
  })
})
