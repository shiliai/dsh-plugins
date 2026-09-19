/**
 * Plugin version shown in the panel footer. The value is injected at build
 * time from package.json (tsdown `define`), so it cannot drift from the
 * authoritative version; tests and raw-TS consumers fall back to the literal.
 * @module @dsh-plugins/dsh-cron/version
 */

export const PLUGIN_VERSION: string = typeof __PLUGIN_VERSION__ === 'string' ? __PLUGIN_VERSION__ : '0.0.0-dev'
