/**
 * The cron-create skill: a guided collect → confirm → create → verify flow
 * over the cron_* tools. Registered whenever the host exposes the skills
 * registry; harmless when it does not.
 * @module @dsh-plugins/dsh-cron/skill
 */

import type { Context } from '@deepseek-ai/cordis'

interface SkillsLike {
  register(skill: { name: string; description: string; content: string; invocation?: { modelInvocable: boolean; userInvocable: boolean } }): () => void
}

const SKILL_CONTENT = `# 创建 dsh-cron 定时任务

按 **收集 → 确认 → 创建 → 验证** 四步帮助用户创建一个宿主侧无人值守定时任务。

## 1. 收集
用 cron_list 了解现有任务,避免重名。需要确认的信息:
- **名称**:字母/数字/-/_,无空格(如 \`wecom-mail-digest\`)。
- **触发方式**(三选一):
  - cron:5 字段表达式(分 时 日 月 周)+ IANA 时区(必须显式,如 \`Asia/Shanghai\`,不要猜测用户的时区,直接询问或取用户环境);
  - everySeconds:固定间隔秒数,最小 60;
  - at:一次性 RFC 3339 时刻,必须带 Z 或数字偏移。
- **任务类型**:
  - agent:提示词将无人值守地走完整 DSH 工具链(可用已装插件的工具与技能);
  - command:子进程 argv(JSON 数组)。
- **可选**:agent 预设 / 钉死模型(provider+model,可带推理等级)/ 权限预设 / 工作目录 / 超时(默认 600s)/ 重叠策略(默认 skip)/ 漏跑策略(默认 skip)。
- **有效期窗口**(循环任务必填):\`endAt\` 时刻或 \`maxDurationSeconds\`(上限一年)。**禁止无限循环任务**,必须与用户确认一个合理终点。

## 2. 确认
把完整参数以清单形式复述给用户,显式请求确认后再创建。给出将要使用的 cron 表达式的中文解释(如 "0 8 * * * = 每天 08:00")。

## 3. 创建
调用 \`cron_create\`,严格按收集到的参数传参。

## 4. 验证
- 向用户报告返回值中的 \`nextFire\` 绝对时间(ISO 8601,标注时区);
- 用 \`cron_list\` 复核任务处于 enabled 状态;
- 提醒:agent 运行的完整过程可在 Web 侧栏「定时任务」的运行历史里打开原生会话回放;进程不存活则不触发。

## 注意
- 任务提示词必须自包含:无人值守运行时没有人可以回答提问,提示词里写明"禁止提问,直接给出结论"。
- 需要通知时,提示词可指示 agent 调用已装插件的发送工具(如 wecom),或在创建时配置 command delivery。
- config/plugin 来源的任务不可用 cron_delete 删除。
`

export function registerCronSkill(ctx: Context): (() => void) | undefined {
  const skills = ctx.get('skills') as SkillsLike | undefined
  if (!skills || typeof skills.register !== 'function') return undefined
  try {
    return skills.register({
      name: 'cron-create',
      description: '创建 dsh-cron 定时任务(cron/间隔/一次性;agent 或 command),含有效期窗口与参数确认流程',
      content: SKILL_CONTENT,
      invocation: { modelInvocable: true, userInvocable: true },
    })
  } catch {
    return undefined
  }
}
