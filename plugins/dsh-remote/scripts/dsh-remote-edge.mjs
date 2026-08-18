#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const legacyActions = new Set(['preflight', 'apply', 'status', 'renewal-check', 'rollback'])
const command = process.argv[2] ?? 'status'
const subcommand = process.argv[3]
const instanceId = command === 'instance' && subcommand !== 'rollback' ? process.argv[4] ?? '' : ''
const hubActions = new Set(['preflight', 'apply', 'status', 'renewal-check', 'rollback', 'acknowledge-alert', 'admin-init', 'admin-rotate'])
const instanceActions = new Set(['add', 'remove', 'status', 'rollback'])
const legacy = legacyActions.has(command)
const interactiveAdmin = command === 'hub' && (subcommand === 'admin-init' || subcommand === 'admin-rotate') && !process.argv.includes('--password-stdin')
if (!legacy && command !== 'hub' && command !== 'instance') fail(`Unknown command: ${command}`)
if (command === 'hub' && !hubActions.has(subcommand)) fail(`Unknown hub action: ${String(subcommand)}`)
if (command === 'instance' && (!instanceActions.has(subcommand) || (subcommand !== 'rollback' && (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(instanceId) || instanceId.includes('--'))))) {
  fail('Instance commands require add|remove|status and a safe instance id.')
}

const option = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}
const host = option('--host', 'vps-tencent-tokyo')
const domain = option('--domain', 'zsh.onlyservice.io')
const baseDomain = option('--base-domain', 'dsh.onlyservice.io')
const receipt = option('--receipt', '')
if (!/^[A-Za-z0-9._-]+$/.test(host)) fail('Invalid SSH host alias.')
if (!/^[a-z0-9.-]+$/.test(domain) || domain.includes('..')) fail('Invalid domain.')
if (!/^[a-z0-9.-]+$/.test(baseDomain) || baseDomain.includes('..')) fail('Invalid base domain.')
if ((command === 'rollback' || ((command === 'hub' || command === 'instance') && subcommand === 'rollback')) && !/^[A-Za-z0-9TZ-]+$/.test(receipt)) fail('A valid --receipt is required for rollback.')

const stage = `/tmp/dsh-remote-edge-${process.pid}`
const files = [
  path.join(root, 'scripts/remote-edge.py'),
  path.join(root, 'scripts/remote-hub.py'),
  path.join(root, 'templates/nginx-site.conf'),
  path.join(root, 'templates/offline.html'),
  path.join(root, 'templates/nginx-socket-group.sh'),
  path.join(root, 'templates/renew-certificate.sh'),
]

try {
  execute('ssh', ['-o', 'BatchMode=yes', host, `install -d -m 700 ${stage}`])
  execute('scp', ['-q', ...files, `${host}:${stage}/`])
  const remoteArgs = legacy
    ? [
        'sudo', '-n', 'python3', `${stage}/remote-edge.py`, command,
        '--domain', domain,
        '--site-template', `${stage}/nginx-site.conf`,
        '--offline-template', `${stage}/offline.html`,
        '--group-init-template', `${stage}/nginx-socket-group.sh`,
        '--renewal-template', `${stage}/renew-certificate.sh`,
      ]
    : [
        'sudo', '-n', 'python3', `${stage}/remote-hub.py`, `${command}-${subcommand}`,
        '--base-domain', baseDomain,
        '--offline-template', `${stage}/offline.html`,
        '--group-init-template', `${stage}/nginx-socket-group.sh`,
      ]
  if (instanceId) remoteArgs.push('--instance-id', instanceId)
  if (receipt) remoteArgs.push('--receipt', receipt)
  if (process.argv.includes('--force')) remoteArgs.push('--force')
  if (process.argv.includes('--password-stdin')) remoteArgs.push('--password-stdin')
  execute('ssh', [...(interactiveAdmin ? ['-tt'] : []), '-o', 'BatchMode=yes', host, remoteArgs.map(shellWord).join(' ')])
} finally {
  spawnSync('ssh', ['-o', 'BatchMode=yes', host, `rm -rf ${stage}`], { stdio: 'ignore' })
}

function execute(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error) fail(result.error.message)
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function shellWord(value) {
  if (!/^[A-Za-z0-9._/:=-]+$/.test(value)) fail(`Unsafe remote argument: ${value}`)
  return value
}

function fail(message) {
  console.error(`dsh-remote-edge: ${message}`)
  process.exit(1)
}
