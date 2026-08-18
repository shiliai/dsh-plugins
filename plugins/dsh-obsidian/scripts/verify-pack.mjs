import { execFileSync } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const directory = await mkdtemp(join(tmpdir(), 'dsh-obsidian-pack-'))
try {
  execFileSync('pnpm', ['pack', '--pack-destination', directory], { cwd: root, stdio: 'inherit' })
  const archive = (await readdir(directory)).find(name => name.endsWith('.tgz'))
  if (archive === undefined) throw new Error('pnpm pack did not create an archive')
  const entries = execFileSync('tar', ['-tzf', join(directory, archive)], { encoding: 'utf8' })
  for (const required of ['package/lib/index.js', 'package/lib/client.js', 'package/lib/types/index.d.ts', 'package/lib/types/client/index.d.ts']) {
    if (!entries.includes(required)) throw new Error(`archive is missing ${required}`)
  }
  const consumer = join(directory, 'consumer')
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (packageJson.peerDependencies.react === undefined || packageJson.peerDependenciesMeta.react?.optional !== true) {
    throw new Error('React must be declared as an optional host peer')
  }
  await mkdir(consumer)
  await writeFile(join(consumer, 'package.json'), JSON.stringify({
    private: true,
    type: 'module',
    dependencies: {
      '@deepseek-ai/dsh-tools': `link:${join(root, 'node_modules/@deepseek-ai/dsh-tools')}`,
      react: packageJson.devDependencies.react,
      'react-dom': packageJson.devDependencies['react-dom'],
      '@types/node': packageJson.devDependencies['@types/node'],
      [packageJson.name]: `file:${join(directory, archive)}`,
    },
  }))
  await writeFile(join(consumer, 'check.ts'), `import '${packageJson.name}'\nimport '${packageJson.name}/client'\n`)
  execFileSync('pnpm', ['install', '--offline', '--ignore-scripts', '--config.auto-install-peers=false'], { cwd: consumer, stdio: 'inherit' })
  await access(join(consumer, 'node_modules', packageJson.name, 'lib', 'index.js'))
  execFileSync(process.execPath, ['--input-type=module', '--eval', `import('${packageJson.name}')`], { cwd: consumer, stdio: 'inherit' })
  execFileSync(join(root, 'node_modules/.bin/tsc'), ['--noEmit', '--skipLibCheck', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'check.ts'], { cwd: consumer, stdio: 'inherit' })
  process.stdout.write(`${join(directory, archive)}\n`)
} finally {
  await rm(directory, { recursive: true, force: true })
}
