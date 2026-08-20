import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  dts: false, // declarations are produced by tsc -p tsconfig.build.json
  clean: true,
  external: [/^@deepseek-ai\//],
})
