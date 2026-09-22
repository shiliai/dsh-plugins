import { execFileSync } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Release packs must never run with the dev hot-loop flag: its `clean: false`
// build keeps stale lib artifacts that no longer correspond to src/ (the flag
// exists for the local overlay only).
if (process.env.DSH_DEV_HOT_LOOP === '1') {
  throw new Error('verify-pack must not run with DSH_DEV_HOT_LOOP=1 set')
}

const root = fileURLToPath(new URL('..', import.meta.url))
const directory = await mkdtemp(join(tmpdir(), 'dsh-agent-team-pack-'))
try {
  execFileSync('pnpm', ['pack', '--pack-destination', directory], { cwd: root, stdio: 'inherit' })
  const archive = (await readdir(directory)).find(name => name.endsWith('.tgz'))
  if (archive === undefined) throw new Error('pnpm pack did not create an archive')
  const entries = execFileSync('tar', ['-tzf', join(directory, archive)], { encoding: 'utf8' })
  for (const required of [
    'package/lib/index.js',
    'package/lib/index.d.ts',
    'package/cordis.patch.yml',
    'package/README.md',
    'package/README.zh.md',
  ]) {
    if (!entries.includes(required)) throw new Error(`archive is missing ${required}`)
  }
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  for (const peer of ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-subagent', '@deepseek-ai/dsh-agent']) {
    if (packageJson.peerDependencies[peer] === undefined || packageJson.peerDependenciesMeta[peer]?.optional !== true) {
      throw new Error(`${peer} must be declared as an optional host peer`)
    }
  }
  const consumer = join(directory, 'consumer')
  await mkdir(consumer)
  await writeFile(join(consumer, 'package.json'), JSON.stringify({
    private: true,
    type: 'module',
    dependencies: {
      '@types/node': packageJson.devDependencies['@types/node'],
      // Runtime peers the bundle imports (defineTool etc.) — the DSH host
      // always provides them; the consumer smoke import needs them present.
      '@deepseek-ai/cordis': packageJson.peerDependencies['@deepseek-ai/cordis'],
      '@deepseek-ai/dsh-agent': packageJson.peerDependencies['@deepseek-ai/dsh-agent'],
      '@deepseek-ai/dsh-llm': packageJson.peerDependencies['@deepseek-ai/dsh-llm'],
      '@deepseek-ai/dsh-subagent': packageJson.peerDependencies['@deepseek-ai/dsh-subagent'],
      '@deepseek-ai/dsh-tools': packageJson.peerDependencies['@deepseek-ai/dsh-tools'],
      [packageJson.name]: `file:${join(directory, archive)}`,
    },
  }))
  await writeFile(join(consumer, 'check.ts'), `import { normalizeConfig, createTeamDelegateTool } from '${packageJson.name}'\nconst config = normalizeConfig({})\nvoid createTeamDelegateTool\ntype C = typeof config\nconst c: C | null = null\nvoid c\n`)
  execFileSync('pnpm', ['install', '--prefer-offline', '--ignore-scripts'], { cwd: consumer, stdio: 'inherit' })
  await access(join(consumer, 'node_modules', packageJson.name, 'lib', 'index.js'))
  execFileSync(process.execPath, ['--input-type=module', '--eval', `import('${packageJson.name}')`], { cwd: consumer, stdio: 'inherit' })
  execFileSync(join(root, 'node_modules/.bin/tsc'), ['--noEmit', '--skipLibCheck', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'check.ts'], { cwd: consumer, stdio: 'inherit' })
  process.stdout.write(`${join(directory, archive)}\n`)
} finally {
  await rm(directory, { recursive: true, force: true })
}
