/**
 * dsh-agent-team cordis plugin: host-plane global tool registration. Registering
 * from the host context puts `team_delegate` in the global tool layer, visible
 * to every session's agent without touching agent presets.
 * @module @dsh-plugins/dsh-agent-team
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-tools'
import { normalizeConfig, type Config } from './config.ts'
import { createTeamDelegateTool } from './tool.ts'

export const name = 'dsh-agent-team'
export const inject = ['tools', 'subagents']

export async function apply(ctx: Context, rawConfig: Config = {}): Promise<void> {
  const config = normalizeConfig(rawConfig)
  const tool = createTeamDelegateTool({ config, subagents: ctx.subagents })
  ctx.effect(() => ctx.tools.register(tool), 'dsh-agent-team: team_delegate tool')
}

export { normalizeConfig } from './config.ts'
export type { Config, Worker, ResolvedConfig } from './config.ts'
export { judge, JEV_ENDPOINT, type JevVerdict } from './jev-client.ts'
export { decide, type Decision } from './router.ts'
export { appendStats, type StatsRecord } from './stats.ts'
export { createTeamDelegateTool, type TeamDelegateDeps, type TeamDelegateResult, type SubagentGateway } from './tool.ts'
