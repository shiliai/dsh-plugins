/**
 * Provider contract every plugin implements to join the config-portability
 * flow. The shared HTTP handler and the shared client tab drive it through
 * these three operations only.
 */

export interface ConfigExportOptions {
  /** When true, credential fields are blanked before leaving the host. */
  redactSecrets: boolean
}

export interface ConfigImportOptions {
  /** Preview mode: validate and report without persisting anything. */
  dryRun: boolean
}

/** Result of one plugin's import (or dry-run import). */
export interface ImportOutcome {
  /** Sections applied — or that would be applied in dry-run mode. */
  applied: string[]
  /** Sections present in the payload but not applied, with reasons in warnings. */
  skipped: string[]
  warnings: string[]
}

/** Contract a plugin implements so its config can be exported and imported. */
export interface ConfigPortabilityProvider {
  /** Stable plugin id; doubles as the key inside the envelope `plugins` map. */
  readonly id: string
  /** Human-facing name shown in the settings tab. */
  readonly displayName: string
  /** Produce this plugin's config section. */
  exportConfig(options: ConfigExportOptions): unknown | Promise<unknown>
  /** Apply (or preview) one plugin config section. */
  importConfig(config: unknown, options: ConfigImportOptions): ImportOutcome | Promise<ImportOutcome>
}
