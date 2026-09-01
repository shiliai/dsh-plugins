import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { PLUGIN_VERSION } from '../src/version.ts'

describe('plugin version contract', () => {
  it('keeps the browser status version equal to package.json', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(PLUGIN_VERSION).toBe('0.3.2')
    expect(PLUGIN_VERSION).toBe(packageJson.version)
  })
})
