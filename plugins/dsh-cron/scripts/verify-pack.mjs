import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const destination = await mkdtemp(join(tmpdir(), 'dsh-cron-pack-'))
try {
  execFileSync('pnpm', ['pack', '--pack-destination', destination], { cwd: root, stdio: 'inherit' })
  const archive = (await readdir(destination)).find((name) => name.endsWith('.tgz'))
  if (!archive) throw new Error('pnpm pack did not produce an archive')
  const entries = execFileSync('tar', ['-tzf', join(destination, archive)], { encoding: 'utf8' })
  for (const required of [
    'package/lib/index.js',
    'package/lib/types/index.d.ts',
    'package/lib/client.js',
    'package/lib/types/client/index.d.ts',
    'package/cordis.patch.yml',
    'package/README.md',
    'package/README.zh.md',
    'package/LICENSE',
  ]) {
    if (!entries.includes(required)) throw new Error(`archive is missing ${required}`)
  }
  const consumer = await mkdtemp(join(tmpdir(), 'dsh-cron-consumer-'))
  try {
    execFileSync('tar', ['-xzf', join(destination, archive), '-C', consumer], { stdio: 'inherit' })
    const serverBundle = await readFile(join(consumer, 'package', 'lib', 'index.js'), 'utf8')
    for (const compiledBehavior of [
      'cron_create',
      'dsh-cron/api',
      'storage domain facility unavailable',
    ]) {
      if (!serverBundle.includes(compiledBehavior)) {
        throw new Error(`compiled server bundle is missing scheduler behavior: ${compiledBehavior}`)
      }
    }
    await mkdir(join(consumer, 'node_modules', '@dsh-plugins'), { recursive: true })
    await symlink(join(consumer, 'package'), join(consumer, 'node_modules', '@dsh-plugins', 'dsh-cron'), 'dir')
    await writeFile(join(consumer, 'consumer.ts'), "import { apply } from '@dsh-plugins/dsh-cron/client'\nvoid apply\n")
    await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022', strict: true, skipLibCheck: true } }))
    execFileSync('pnpm', ['exec', 'tsc', '--noEmit', '-p', join(consumer, 'tsconfig.json')], { cwd: root, stdio: 'inherit' })
  } finally {
    await rm(consumer, { recursive: true, force: true })
  }
  process.stdout.write(`${join(destination, archive)}\n`)
} finally {
  await rm(destination, { recursive: true, force: true })
}
