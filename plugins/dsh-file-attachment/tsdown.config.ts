import { defineConfig } from 'tsdown'

const PACKAGE_ID = '@dsh-plugins/dsh-file-attachment'

// With DSH_DEV_HOT_LOOP=1 (the local hot-iteration overlay, issue #110), a
// rebuild must keep the lib directory inode — `clean: true` deletes the whole
// directory, which silently kills the host's file watcher. Release builds
// keep the default clean behavior.
const DEV_HOT_LOOP = process.env.DSH_DEV_HOT_LOOP === '1'

export default defineConfig([
  {
    name: PACKAGE_ID,
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    dts: false,
    clean: !DEV_HOT_LOOP,
    external: [/^@deepseek-ai\//],
  },
  {
    name: `${PACKAGE_ID}/client`,
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    minify: true,
    dts: false,
    clean: false,
    external: [
      'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
      '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-runtime/client',
      '@deepseek-ai/dsh-client-ui-conversation/client', '@deepseek-ai/dsh-client-ui-slots',
    ],
    noExternal: id => id.startsWith('@deepseek-ai/') ? undefined : true,
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
