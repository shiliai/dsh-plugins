import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { interpolate } from '@deepseek-ai/cordis-plugin-loader'
import { parseDocument } from 'yaml'
import { describe, expect, it } from 'vitest'
import { apply, inject } from '../src/index.ts'

function readConfigurationSnippet(readme: string): string {
  const section = readme.match(/Add a user patch[\s\S]*?```yaml\n([\s\S]*?)```/u)
  if (section?.[1] === undefined) throw new Error('README configuration snippet is missing')
  return section[1]
}

function loaderFixture() {
  const routes: Array<{ path: string }> = []
  const effects: Array<() => unknown> = []
  const ctx = {
    webServer: { register: (route: { path: string }) => { routes.push(route); return () => {} } },
    tools: { register: () => () => {} },
    effect: (register: () => (() => unknown)) => { effects.push(register()) },
    get: () => undefined,
  }
  return { routes, ctx, effects }
}

describe('README clean-profile YAML/loader smoke (isolated temporary fixture, no real DSH profile)', () => {
  it('parses, interpolates empty fixture credentials, and loads the exact documented entry', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'dsh-wecom-readme-profile-'))
    try {
      const snippet = readConfigurationSnippet(await readFile(new URL('../README.md', import.meta.url), 'utf8'))
      const patchPath = join(profile, 'cordis.patch.yml')
      await writeFile(patchPath, snippet)
      const document = parseDocument(await readFile(patchPath, 'utf8'), {
        customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (expression: string) => ({ __jsExpr: expression }) }],
      })
      expect(document.errors).toEqual([])
      const loaded = interpolate({ process: { env: { WECOM_BOT_ID: '', WECOM_BOT_SECRET: '' } } }, document.toJS()) as Array<{ insert: Array<{ inject: string[]; config: { botId: string; botSecret: string } }> }>
      const entry = loaded[0]?.insert[0]
      expect(entry?.inject).toEqual(inject)
      expect(entry?.config).toMatchObject({ botId: '', botSecret: '' })
      const fixture = loaderFixture()
      await apply(fixture.ctx as never, entry!.config)
      expect(fixture.routes.some(route => route.path === '/dsh-wecom/api')).toBe(true)
      expect(fixture.effects).toHaveLength(2)
    } finally {
      await rm(profile, { recursive: true, force: true })
    }
  })
})
