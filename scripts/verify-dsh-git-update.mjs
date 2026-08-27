import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'

const fixturePlugins = [
  { name: '@dsh-plugins/dsh-file-attachment', directory: 'plugins/dsh-file-attachment', bundleId: 'dsh-file-attachment' },
  { name: '@dsh-plugins/dsh-obsidian', directory: 'plugins/dsh-obsidian', bundleId: 'dsh-obsidian' },
  { name: '@dsh-plugins/dsh-wecom', directory: 'plugins/dsh-wecom', bundleId: 'dsh-wecom' },
]
const requireFromPlugin = createRequire(resolve('plugins/dsh-obsidian/package.json'))
const dshPackage = requireFromPlugin.resolve('@deepseek-ai/dsh/package.json')
const dshBin = join(dirname(dshPackage), 'lib/bin.js')
const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-git-update-'))
const source = join(root, 'source')
const updaterFixture = join(source, 'scripts/dsh-plugin-updater')
const dshHome = join(root, 'dsh-home')
const latestVersions = new Map(fixturePlugins.map((plugin) => [plugin.name, '0.1.0']))
const exec = promisify(execFile)

const server = createServer((request, response) => {
  const fixture = fixturePlugins.find((plugin) => request.url === `/${plugin.directory}/package.json`)
  if (fixture) {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ name: fixture.name, version: latestVersions.get(fixture.name) }))
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

async function writePlugin(fixture, version) {
  const plugin = join(source, fixture.directory)
  await mkdir(plugin, { recursive: true })
  await writeFile(join(plugin, 'package.json'), `${JSON.stringify({
    name: fixture.name,
    version,
    type: 'module',
    main: './index.js',
    scripts: { prepare: 'node prepare.mjs' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2)}\n`)
  await writeFile(join(plugin, 'prepare.mjs'), "import { writeFile } from 'node:fs/promises'\nawait writeFile('prepared.txt', 'prepared\\n')\n")
  await writeFile(join(plugin, 'index.js'), `export const version = '${version}'\n`)
  await writeFile(join(plugin, 'cordis.patch.yml'), `- id: ${fixture.bundleId}\n  name: '${fixture.name}'\n`)
}

try {
  await mkdir(updaterFixture, { recursive: true })
  await writeFile(join(updaterFixture, 'package.json'), await readFile(resolve('scripts/dsh-plugin-updater/package.json')))
  await writeFile(join(updaterFixture, 'cli.mjs'), await readFile(resolve('scripts/dsh-plugin-updater/cli.mjs')))
  await run('git', ['init', '--quiet', source])
  await run('git', ['-C', source, 'config', 'user.name', 'DSH Update Test'])
  await run('git', ['-C', source, 'config', 'user.email', 'fixture'])
  for (const fixture of fixturePlugins) await writePlugin(fixture, '0.1.0')
  await run('git', ['-C', source, 'add', '.'])
  await run('git', ['-c', 'core.hooksPath=/dev/null', '-C', source, 'commit', '--quiet', '-m', 'fixture 0.1.0'])

  for (const fixture of fixturePlugins) {
    const plugin = join(source, fixture.directory)
    await run('pnpm', ['--dir', plugin, 'pack', '--pack-destination', root])
    const archiveName = fixture.name.replace(/^@/, '').replaceAll('/', '-')
    await run(process.execPath, [dshBin, 'plugin', '--profile', 'web', 'add', join(root, `${archiveName}-0.1.0.tgz`)])
  }
  await run(process.execPath, [
    dshBin, 'plugin', '--profile', 'web',
    'config', 'set', '--location=project', '--json', 'allowBuilds', '{"existing-package":false}',
  ])
  for (const fixture of fixturePlugins) await writePlugin(fixture, '0.1.1')
  await run('git', ['-C', source, 'add', '.'])
  await run('git', ['-c', 'core.hooksPath=/dev/null', '-C', source, 'commit', '--quiet', '-m', 'fixture 0.1.1'])
  for (const fixture of fixturePlugins) latestVersions.set(fixture.name, '0.1.1')
  const updaterSpec = `git+file://${source}#path:/scripts/dsh-plugin-updater`

  const check = await run(process.execPath, [
    dshBin, 'plugin', '--profile', 'web', 'dlx', updaterSpec, 'check',
  ])
  assert.match(check, /@dsh-plugins\/dsh-file-attachment: 0\.1\.0 -> 0\.1\.1 \(outdated\)/)
  assert.match(check, /@dsh-plugins\/dsh-obsidian: 0\.1\.0 -> 0\.1\.1 \(outdated\)/)
  assert.match(check, /@dsh-plugins\/dsh-wecom: 0\.1\.0 -> 0\.1\.1 \(outdated\)/)

  await run(process.execPath, [
    dshBin, 'plugin', '--profile', 'web', 'dlx', updaterSpec, 'update',
  ])

  const profile = join(dshHome, 'profiles/web')
  const profileManifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  for (const fixture of fixturePlugins) {
    const installedPath = join(profile, 'node_modules', ...fixture.name.split('/'))
    const installed = JSON.parse(await readFile(join(installedPath, 'package.json'), 'utf8'))
    assert.equal(installed.version, '0.1.1')
    assert.equal(await readFile(join(installedPath, 'prepared.txt'), 'utf8'), 'prepared\n')
    assert.ok(profileManifest.dsh.profile.bundles.includes(fixture.name))
    assert.match(profileManifest.dependencies[fixture.name], /^git\+file:/)
  }
  const allowBuilds = JSON.parse(await run(process.execPath, [
    dshBin, 'plugin', '--profile', 'web', 'config', 'get', '--json', 'allowBuilds',
  ]))
  assert.equal(allowBuilds['existing-package'], false)
  for (const fixture of fixturePlugins) {
    assert.equal(allowBuilds[`${fixture.name}@git+file://${source}`], true)
  }

  console.log('verified multi-plugin update detection, source migration, automatic update, and bundle reconciliation')
} finally {
  await new Promise((resolveClose) => server.close(resolveClose))
  await rm(root, { recursive: true, force: true })
}
