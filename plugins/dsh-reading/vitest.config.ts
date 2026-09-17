import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// The shared core is resolved from workspace source (see tsdown.config.ts);
// it is not an installed dependency of this plugin.
const readingCoreSource = fileURLToPath(new URL('../../packages/dsh-reading-core/src/index.ts', import.meta.url))

export default defineConfig({
  resolve: {
    alias: { '@dsh-plugins/dsh-reading-core': readingCoreSource },
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    exclude: ['tests/e2e/**'],
    coverage: { provider: 'v8', reporter: ['text', 'json-summary'] },
  },
})
