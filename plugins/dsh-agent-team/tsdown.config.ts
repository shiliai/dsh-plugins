import { defineConfig } from 'tsdown'

// Dev hot-iteration loop (live DSH + cordis-plugin-hmr watching lib/): the
// rebuild must keep the lib directory inode — `clean: true` deletes the whole
// directory, which silently kills the host's file watcher. Release builds
// keep the default clean behavior.
const DEV_HOT_LOOP = process.env.DSH_DEV_HOT_LOOP === '1'

export default defineConfig({
  name: '@dsh-plugins/dsh-agent-team',
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  dts: true,
  clean: !DEV_HOT_LOOP,
  external: [/^@deepseek-ai\//],
})
