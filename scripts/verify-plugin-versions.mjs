import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const repositoryUrl = 'git+https://github.com/shiliai/dsh-plugins.git'
const plugins = [
  {
    directory: 'plugins/dsh-obsidian',
    packageName: '@dsh-plugins/dsh-obsidian',
  },
  {
    directory: 'plugins/dsh-remote',
    packageName: '@dsh-plugins/dsh-remote',
  },
]

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

for (const plugin of plugins) {
  const manifest = JSON.parse(await readFile(`${plugin.directory}/package.json`, 'utf8'))
  assert.equal(manifest.name, plugin.packageName)
  assert.match(manifest.version, semver, `${plugin.packageName} must use strict SemVer`)
  assert.deepEqual(manifest.repository, {
    type: 'git',
    url: repositoryUrl,
    directory: plugin.directory,
  })
  assert.equal(manifest.scripts?.prepare, 'pnpm run build')
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
}

const agents = await readFile('AGENTS.md', 'utf8')
assert.match(agents, /dsh plugin --profile <profile> dlx/)
assert.match(agents, /github:shiliai\/dsh-plugins#path:\/plugins\/<plugin>/)

const readme = await readFile('README.md', 'utf8')
for (const plugin of plugins) {
  assert.ok(readme.includes(`github:shiliai/dsh-plugins#path:/${plugin.directory}`))
}
assert.ok(readme.includes('github:shiliai/dsh-plugins#path:/scripts/dsh-plugin-updater'))

console.log(`verified ${plugins.length} independently versioned GitHub-source plugins`)
