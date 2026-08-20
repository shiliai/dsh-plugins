import { execFileSync } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const destination = await mkdtemp(join(tmpdir(), 'dsh-wecom-pack-'))
try {
  execFileSync('pnpm', ['pack', '--pack-destination', destination], { cwd: root, stdio: 'inherit' })
  const archive = (await readdir(destination)).find((name) => name.endsWith('.tgz'))
  if (!archive) throw new Error('pnpm pack did not produce an archive')
  const entries = execFileSync('tar', ['-tzf', join(destination, archive)], { encoding: 'utf8' })
  for (const required of [
    'package/lib/index.js',
    'package/lib/types/index.d.ts',
    'package/cordis.patch.yml',
    'package/README.md',
    'package/LICENSE',
  ]) {
    if (!entries.includes(required)) throw new Error(`archive is missing ${required}`)
  }
  process.stdout.write(`${join(destination, archive)}\n`)
} finally {
  await rm(destination, { recursive: true, force: true })
}
