import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, resolve } from 'node:path'
import { defineConfig } from 'tsdown'

const PACKAGE_ID = '@dsh-plugins/dsh-reading'
const CSS_PREFIX = '\0dsh-reading-css:'
const CSS_SUFFIX = '.mjs'
const RAW_PREFIX = '\0dsh-reading-raw:'
const require = createRequire(import.meta.url)

interface InlineCssPlugin {
  name: string
  resolveId(source: string, importer: string | undefined): string | null
  load(this: { addWatchFile(path: string): void }, id: string): Promise<string | null>
}

function inlineCssModules(): InlineCssPlugin {
  return {
    name: 'dsh-reading-inline-css-modules',
    resolveId(source, importer) {
      if (!source.endsWith('.module.css?dsh-inline') || importer === undefined) return null
      return `${CSS_PREFIX}${resolve(importer, '..', source.slice(0, -'?dsh-inline'.length))}${CSS_SUFFIX}`
    },
    async load(id) {
      if (!id.startsWith(CSS_PREFIX)) return null
      const path = id.slice(CSS_PREFIX.length, -CSS_SUFFIX.length)
      this.addWatchFile(path)
      let source = await readFile(path, 'utf8')
      // Keep CSS-module global selectors untouched while scoping local classes.
      // Protecting the whole selector also prevents :global(.foo) from being
      // accidentally rewritten as a local class.
      const globalSelectors: string[] = []
      source = source.replace(/:global\(([^()]*)\)/gu, (_match, selector: string) => {
        const index = globalSelectors.push(selector) - 1
        return `__DSH_READING_GLOBAL_${index}__`
      })
      const names = new Set<string>()
      for (const match of source.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/gu)) {
        const name = match[1]
        if (name !== undefined) names.add(name)
      }
      const classes = Object.fromEntries([...names].map(name => [name, `dshReading_${name}`]))
      for (const [name, scoped] of Object.entries(classes)) {
        source = source.replaceAll(`.${name}`, `.${scoped}`)
      }
      for (const [index, selector] of globalSelectors.entries()) {
        source = source.replaceAll(`__DSH_READING_GLOBAL_${index}__`, selector)
      }
      const tagId = `${PACKAGE_ID}/${basename(path)}`
      return [
        `const css = ${JSON.stringify(source)};`,
        `const tagId = ${JSON.stringify(tagId)};`,
        "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
        "  const tag = document.createElement('style');",
        `  tag.dataset.plugin = ${JSON.stringify(PACKAGE_ID)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classes)};`,
      ].join('\n')
    },
  }
}

/** Inline `x?dsh-raw` imports as JSON-string default exports (single-file client bundle). */
function inlineRawModules(): InlineCssPlugin {
  return {
    name: 'dsh-reading-inline-raw',
    resolveId(source) {
      if (!source.endsWith('?dsh-raw')) return null
      const specifier = source.slice(0, -'?dsh-raw'.length)
      const path = require.resolve(specifier)
      return `${RAW_PREFIX}${path}`
    },
    async load(id) {
      if (!id.startsWith(RAW_PREFIX)) return null
      const path = id.slice(RAW_PREFIX.length)
      this.addWatchFile(path)
      const source = await readFile(path, 'utf8')
      return `export default ${JSON.stringify(source)};`
    },
  }
}

export default defineConfig([
  {
    name: PACKAGE_ID,
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    dts: false,
    clean: true,
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
      '@deepseek-ai/dsh-client-ui-slots',
    ],
    noExternal: id => id.startsWith('@deepseek-ai/') ? undefined : true,
    plugins: [inlineCssModules(), inlineRawModules()],
    outputOptions: {
      // foliate-js uses dynamic relative imports (vendor zip/fflate) that must be
      // inlined into the single-file client bundle consumed by the DSH module loader.
      inlineDynamicImports: true,
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
