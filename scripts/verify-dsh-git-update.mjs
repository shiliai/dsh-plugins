import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'

const requireFromPlugin = createRequire(resolve('plugins/dsh-obsidian/package.json'))
const dshPackage = requireFromPlugin.resolve('@deepseek-ai/dsh/package.json')
const dshBin = join(dirname(dshPackage), 'lib/bin.js')
const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-git-update-'))
const source = join(root, 'source')
const plugin = join(source, 'plugins/dsh-obsidian')
const updaterFixture = join(source, 'scripts/dsh-plugin-updater')
const dshHome = join(root, 'dsh-home')
let latestVersion = '0.1.0'
const exec = promisify(execFile)

const server = createServer((request, response) => {
  if (request.url === '/plugins/dsh-obsidian/package.json') {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ name: '@dsh-plugins/dsh-obsidian', version: latestVersion }))
    return
  }
  response.statusCode = 404
  response.end('not found')
})
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
const address = server.address()
const env = {
  ...process.env,
  DSH_HOME: dshHome,
  DSH_PLUGIN_UPDATE_MANIFEST_BASE: `http://127.0.0.1:${address.port}`,
  DSH_PLUGIN_UPDATE_SOURCE_BASE: `git+file://${source}#path:`,
  DSH_PLUGIN_UPDATE_BUILD_REPOSITORY: `git+file://${source}`,
}

async function run(command, args) {
  const result = await exec(command, args, {
    encoding: 'utf8',
    env,
    maxBuffer: 10 * 1024 * 1024,
  })
  return result.stdout
}

async function writePlugin(version) {
  await writeFile(join(plugin, 'package.json'), `${JSON.stringify({
    name: '@dsh-plugins/dsh-obsidian',
    version,
    type: 'module',
    main: './index.js',
    scripts: { prepare: 'node prepare.mjs' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2)}\n`)
  await writeFile(join(plugin, 'prepare.mjs'), "import { writeFile } from 'node:fs/promises'\nawait writeFile('prepared.txt', 'prepared\\n')\n")
  await writeFile(join(plugin, 'index.js'), `export const version = '${version}'\n`)
  await writeFile(join(plugin, 'cordis.patch.yml'), "- id: dsh-obsidian\n  name: '@dsh-plugins/dsh-obsidian'\n")
}

try {
  await mkdir(plugin, { recursive: true })
  await mkdir(updaterFixture, { recursive: true })
  await writeFile(join(updaterFixture, 'package.json'), await readFile(resolve('scripts/dsh-plugin-updater/package.json')))
  await writeFile(join(updaterFixture, 'cli.mjs'), await readFile(resolve('scripts/dsh-plugin-updater/cli.mjs')))
  await run('git', ['init', '--quiet', source])
  await run('git', ['-C', source, 'config', 'user.name', 'DSH Update Test'])
  await run('git', ['-C', source, 'config', 'user.email', 'fixture'])
  await writePlugin('0.1.0')
  await run('git', ['-C', source, 'add', '.'])
  await run('git', ['-C', source, 'commit', '--quiet', '-m', 'fixture 0.1.0'])

  await run('pnpm', ['--dir', plugin, 'pack', '--pack-destination', root])
  const archive = join(root, 'dsh-plugins-dsh-obsidian-0.1.0.tgz')
  await run(process.execPath, [dshBin, 'plugin', '--profile', 'web', 'add', archive])
  await run(process.execPath, [
    dshBin, 'plugin', '--profile', 'web',
    'config', 'set', '--location=project', '--json', 'allowBuilds', '{"existing-package":false}',
  ])
  await writePlugin('0.1.1')
  await run('git', ['-C', source, 'add', '.'])
  await run('git', ['-C', source, 'commit', '--quiet', '-m', 'fixture 0.1.1'])
  latestVersion = '0.1.1'
  const updaterSpec = `git+file://${source}#path:/scripts/dsh-plugin-updater`

  const check = await run(process.execPath, [
    dshBin, 'plugin', '--profile', 'web', 'dlx', updaterSpec, 'check',
  ])
  assert.match(check, /@dsh-plugins\/dsh-obsidian: 0\.1\.0 -> 0\.1\.1 \(outdated\)/)

  await run(process.execPath, [
    dshBin, 'plugin', '--profile', 'web', 'dlx', updaterSpec, 'update',
  ])

  const profile = join(dshHome, 'profiles/web')
  const installed = JSON.parse(await readFile(join(profile, 'node_modules/@dsh-plugins/dsh-obsidian/package.json'), 'utf8'))
  assert.equal(installed.version, '0.1.1')
  assert.equal(await readFile(join(profile, 'node_modules/@dsh-plugins/dsh-obsidian/prepared.txt'), 'utf8'), 'prepared\n')
  const profileManifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  assert.ok(profileManifest.dsh.profile.bundles.includes('@dsh-plugins/dsh-obsidian'))
  assert.match(profileManifest.dependencies['@dsh-plugins/dsh-obsidian'], /^git\+file:/)
  const allowBuilds = JSON.parse(await run(process.execPath, [
    dshBin, 'plugin', '--profile', 'web', 'config', 'get', '--json', 'allowBuilds',
  ]))
  assert.equal(allowBuilds['existing-package'], false)
  assert.equal(allowBuilds[`@dsh-plugins/dsh-obsidian@git+file://${source}`], true)

  console.log('verified dsh update detection, source migration, automatic update, and bundle reconciliation')
} finally {
  await new Promise((resolveClose) => server.close(resolveClose))
  await rm(root, { recursive: true, force: true })
}
