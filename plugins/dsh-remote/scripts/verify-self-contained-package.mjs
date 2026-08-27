#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
assert.deepEqual(packageJson.dependencies ?? {}, {}, 'published package must not require registry dependencies')

const server = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const bareImport = packageName => new RegExp(
  String.raw`(?:from\s*|import\s*\(|require\()\s*['"]${packageName}(?:\/[^'"]*)?['"]`,
  'u',
)

assert.doesNotMatch(server, bareImport('http-proxy'), 'server bundle must inline http-proxy')
assert.doesNotMatch(client, bareImport('lucide-react'), 'client bundle must inline lucide-react')

console.log('self-contained package verification passed')
