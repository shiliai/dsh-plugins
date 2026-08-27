import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export interface ParsedCommand {
  /** command name without the leading slash */
  name: string
  /** everything after the command name */
  arg: string
}

/** Split a WeCom message into `{name, arg}` only when it is a slash command. */
export function parseCommand(text: string): ParsedCommand | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return undefined
  const [rawName, ...rest] = trimmed.slice(1).split(/\s+/)
  if (!rawName) return undefined
  return { name: rawName.toLowerCase(), arg: rest.join(' ').trim() }
}

export const COMMANDS: Array<{ name: string; usage: string; desc: string }> = [
  { name: 'help', usage: '/help', desc: '显示本帮助' },
  { name: 'new', usage: '/new', desc: '在工作区开启新的对话（新建独立会话）' },
  { name: 'cd', usage: '/cd [目录]', desc: '切换工作目录（无参数显示当前目录，切换后开启新会话）' },
  { name: 'pwd', usage: '/pwd', desc: '显示当前工作目录' },
  { name: 'agent', usage: '/agent [名称]', desc: '切换 Agent（无参数列出可用 Agent 并显示当前项，切换后开启新会话）' },
  { name: 'status', usage: '/status', desc: '显示当前会话 / 目录 / Agent / 模型状态' },
  { name: 'sessions', usage: '/sessions [会话ID]', desc: '列出当前目录下的会话；带 ID 则绑定到该会话' },
  { name: 'attach', usage: '/attach [会话ID]', desc: '绑定到某个 DSH web 会话以共享对话（无参数显示当前绑定）' },
  { name: 'detach', usage: '/detach', desc: '解除 web 会话绑定，回到本聊天独立会话' },
]

/** Render the `/help` text listing every supported command. */
export function renderHelp(): string {
  const lines = ['📖 可用命令：', ...COMMANDS.map((c) => `· ${c.usage}\n　${c.desc}`)]
  return lines.join('\n')
}

/**
 * Resolve a `/cd` argument to an absolute directory path.
 * - empty / `~` / `-` → home directory
 * - absolute paths used as-is
 * - `~/...` expanded against home
 * - other relative paths resolved against `base`
 */
export function resolveWorkingDir(input: string, base: string): string {
  const arg = input.trim()
  if (arg === '' || arg === '~' || arg === '-') return homedir()
  if (arg === '~/') return homedir()
  if (arg.startsWith('~/')) return join(homedir(), arg.slice(2))
  if (arg.startsWith('~')) return join(homedir(), arg.slice(1))
  return isAbsolute(arg) ? arg : resolve(base, arg)
}
