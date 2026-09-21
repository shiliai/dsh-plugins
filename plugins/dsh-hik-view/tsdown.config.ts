import { defineConfig } from 'tsdown'

const PACKAGE_ID = 'dsh-hik-view'
// With DSH_DEV_HOT_LOOP=1 (the local hot-iteration overlay), a rebuild must
// keep the lib directory inode — `clean: true` deletes the whole directory,
// which silently kills the host's file watcher. Release builds keep the
// default clean behavior.
const DEV_HOT_LOOP = process.env.DSH_DEV_HOT_LOOP === '1'

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    dts: true,
    clean: !DEV_HOT_LOOP,
    external: [/^@deepseek-ai\//, 'schemastery'],
  },
  {
    entry: { client: 'src/client.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    // Kept readable on purpose: the MJPEG relay is diagnosed in the field
    // (industrial boxes without source checkouts), so the served bundle
    // stays as comment-bearing as the loader wrapper allows.
    minify: false,
    dts: false,
    clean: false,
    external: ['react', 'react/jsx-runtime'],
    outputOptions: {
      inlineDynamicImports: true,
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
