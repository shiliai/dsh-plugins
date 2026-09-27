import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// The shared core is resolved from workspace source (see tsdown.config.ts);
// it is not an installed dependency of this plugin.
const readingCoreSource = fileURLToPath(new URL('../../packages/dsh-reading-core/src/index.ts', import.meta.url))
// Same source-inline resolution for the config-portability contract; the
// `/client` entry must precede the bare specifier (longest prefix wins).
const portabilitySource = fileURLToPath(new URL('../../packages/dsh-config-portability/src/index.ts', import.meta.url))
const portabilityClientSource = fileURLToPath(new URL('../../packages/dsh-config-portability/src/client.tsx', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@dsh-plugins/dsh-config-portability/client': portabilityClientSource,
      '@dsh-plugins/dsh-config-portability': portabilitySource,
      '@dsh-plugins/dsh-reading-core': readingCoreSource,
    },
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    exclude: ['tests/e2e/**'],
    coverage: { provider: 'v8', reporter: ['text', 'json-summary'] },
  },
})
