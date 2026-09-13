import pkg from '../../package.json' with { type: 'json' }

/** Plugin version baked in at build time from package.json. */
export const pluginVersion: string = pkg.version
