/**
 * Shared config-portability envelope contract.
 *
 * A config export is a pure-JSON envelope (no book binaries, no progress, no
 * annotations). Multi-plugin exports are produced by merging the `plugins`
 * maps of single-plugin envelopes; a single-plugin export is the same
 * structure restricted to one key.
 */

/** Envelope discriminator shared by every DSH config export. */
export const CONFIG_EXPORT_KIND = 'dsh-config-export'

/** Current envelope format version. Importers reject newer versions. */
export const CONFIG_FORMAT_VERSION = 1

/** One plugin's section inside the envelope. */
export interface ConfigExportSection {
  displayName: string
  /** Plugin-defined configuration payload; opaque to the shared contract. */
  config: unknown
}

/** The full config-export envelope. */
export interface ConfigExportEnvelope {
  kind: typeof CONFIG_EXPORT_KIND
  formatVersion: number
  /** ISO-8601 timestamp of the (earliest) export. */
  exportedAt: string
  plugins: Record<string, ConfigExportSection>
}

/** Error type shared by the config-portability contract. Carries an HTTP status and stable code. */
export class ConfigPortabilityError extends Error {
  readonly status: number
  readonly code: string

  constructor(message: string, code: string, status: number) {
    super(message)
    this.name = 'ConfigPortabilityError'
    this.code = code
    this.status = status
  }
}

/** Input for {@link buildEnvelope}: one plugin's section keyed by plugin id. */
export type BuildEnvelopeInput = Record<string, Omit<ConfigExportSection, never>>

/** Build a single-plugin (or pre-merged) envelope with the current format version. */
export function buildEnvelope(plugins: BuildEnvelopeInput, exportedAt: string = new Date().toISOString()): ConfigExportEnvelope {
  const sections: Record<string, ConfigExportSection> = {}
  for (const [id, section] of Object.entries(plugins)) {
    if (section === undefined || section === null || typeof section !== 'object' || Array.isArray(section)) {
      throw new ConfigPortabilityError(`Config section for "${id}" must be an object.`, 'INVALID_SECTION', 400)
    }
    if (typeof section.displayName !== 'string' || section.displayName.trim() === '') {
      throw new ConfigPortabilityError(`Config section for "${id}" requires a displayName.`, 'INVALID_SECTION', 400)
    }
    sections[id] = { displayName: section.displayName, config: section.config }
  }
  return { kind: CONFIG_EXPORT_KIND, formatVersion: CONFIG_FORMAT_VERSION, exportedAt, plugins: sections }
}

/**
 * Merge several parsed envelopes into one. Later envelopes win on key
 * conflicts; `exportedAt` keeps the earliest timestamp so it reflects the age
 * of the oldest merged data.
 */
export function mergeEnvelopes(...envelopes: ConfigExportEnvelope[]): ConfigExportEnvelope {
  if (envelopes.length === 0) throw new ConfigPortabilityError('No envelopes to merge.', 'INVALID_ENVELOPE', 400)
  const plugins: Record<string, ConfigExportSection> = {}
  let exportedAt: string | undefined
  for (const envelope of envelopes) {
    for (const [id, section] of Object.entries(envelope.plugins)) plugins[id] = section
    if (exportedAt === undefined || envelope.exportedAt < exportedAt) exportedAt = envelope.exportedAt
  }
  return { kind: CONFIG_EXPORT_KIND, formatVersion: CONFIG_FORMAT_VERSION, exportedAt: exportedAt ?? new Date().toISOString(), plugins }
}

/**
 * Strictly validate an untrusted value as a config-export envelope.
 * Throws {@link ConfigPortabilityError} on any structural problem and on
 * format versions newer than {@link CONFIG_FORMAT_VERSION}.
 */
export function parseEnvelope(value: unknown): ConfigExportEnvelope {
  if (!isRecord(value)) throw new ConfigPortabilityError('Config export must be a JSON object.', 'INVALID_ENVELOPE', 400)
  if (value.kind !== CONFIG_EXPORT_KIND) throw new ConfigPortabilityError('File is not a DSH config export.', 'INVALID_ENVELOPE', 400)
  if (typeof value.formatVersion !== 'number' || !Number.isInteger(value.formatVersion)) {
    throw new ConfigPortabilityError('Config export format version is invalid.', 'INVALID_ENVELOPE', 400)
  }
  if (value.formatVersion > CONFIG_FORMAT_VERSION) {
    throw new ConfigPortabilityError(`Config export format version ${value.formatVersion} is newer than supported version ${CONFIG_FORMAT_VERSION}.`, 'UNSUPPORTED_VERSION', 400)
  }
  if (value.formatVersion < 1) throw new ConfigPortabilityError('Config export format version is invalid.', 'INVALID_ENVELOPE', 400)
  if (typeof value.exportedAt !== 'string' || value.exportedAt.trim() === '') {
    throw new ConfigPortabilityError('Config export is missing exportedAt.', 'INVALID_ENVELOPE', 400)
  }
  if (!isRecord(value.plugins)) throw new ConfigPortabilityError('Config export requires a plugins object.', 'INVALID_ENVELOPE', 400)
  const plugins: Record<string, ConfigExportSection> = {}
  for (const [id, section] of Object.entries(value.plugins)) {
    if (!isRecord(section) || typeof section.displayName !== 'string' || section.displayName.trim() === '' || !('config' in section)) {
      throw new ConfigPortabilityError(`Config section for "${id}" is malformed.`, 'INVALID_SECTION', 400)
    }
    plugins[id] = { displayName: section.displayName, config: section.config }
  }
  return { kind: CONFIG_EXPORT_KIND, formatVersion: value.formatVersion, exportedAt: value.exportedAt, plugins }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
