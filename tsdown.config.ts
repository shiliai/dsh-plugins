import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { defineConfig } from 'tsdown'

const PACKAGE_ID = '@dsh-plugins/dsh-obsidian'
const CSS_PREFIX = '\0dsh-obsidian-css:'
const CSS_SUFFIX = '.mjs'

interface InlineCssPlugin {
  name: string
  resolveId(source: string, importer: string | undefined): string | null
  load(this: { addWatchFile(path: string): void }, id: string): Promise<string | null>
}

function inlineCssModules(): InlineCssPlugin {
  return {
    name: 'dsh-obsidian-inline-css-modules',
    resolveId(source, importer) {
      if (!source.endsWith('.module.css?dsh-inline') || importer === undefined) return null
      return `${CSS_PREFIX}${resolve(importer, '..', source.slice(0, -'?dsh-inline'.length))}${CSS_SUFFIX}`
    },
    async load(id) {
      if (!id.startsWith(CSS_PREFIX)) return null
      const path = id.slice(CSS_PREFIX.length, -CSS_SUFFIX.length)
      this.addWatchFile(path)
      let source = await readFile(path, 'utf8')
      const names = new Set<string>()
      for (const match of source.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/gu)) {
        const name = match[1]
        if (name !== undefined) names.add(name)
      }
      const classes = Object.fromEntries([...names].map(name => [name, `dshObsidian_${name}`]))
      for (const [name, scoped] of Object.entries(classes)) {
        source = source.replaceAll(`.${name}`, `.${scoped}`)
      }
      source = source.replaceAll(':global(*)', '*')
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
    plugins: [inlineCssModules()],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
