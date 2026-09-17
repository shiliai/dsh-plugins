# dsh-cron(宿主侧定时任务调度器)

[DeepSeek Harness](https://github.com/shiliai/dsh-plugins)(DSH)的宿主侧
无人值守调度插件。一条 job = **触发 + 任务 + 策略 + 可选投递**,不属于任何
交互会话,进程存活期间自动触发。与官方 `@deepseek-ai/dsh-schedule`
(会话内持久提醒)互补。设计文档:`docs/plans/dsh-cron-v1.md`。

## 安装

```bash
dsh plugin --profile web add \
  'github:shiliai/dsh-plugins#path:/plugins/dsh-cron'
```

升级走仓库更新器(普通 `pnpm outdated` 无法发现 Git 源的新提交):

```bash
dsh plugin --profile web --config.dlx-cache-max-age=0 dlx \
  'github:shiliai/dsh-plugins#path:/scripts/dsh-plugin-updater' check
```

## 能力

- **触发**(三选一):`cron`(5 字段表达式 + **显式 IANA `timeZone`**,永不
  读取进程时区)、`everySeconds`(锚点对齐固定间隔,最小 60 秒)、`at`
  (一次性 RFC 3339 时刻,必须带 Z 或数字偏移)。
- **任务**:`agent` —— 通过 `ctx.agents.create` 开一次性 agent,提示词带
  `[CRON RUN]` 无人值守 framing,等待静默后取最后一条 assistant 消息作摘要,
  随后 dispose;`command` —— 子进程,记录退出码与输出尾部。
- **可靠性**:at-most-once(`lastFiredMs` 在执行前落盘)、漏跑
  `skip | runOnce`、重叠 `skip | queue(1) | replace`、崩溃修复(启动时把
  running 记录修复为 aborted)、时钟纪律(tick 循环每次唤醒重读墙钟)、
  循环任务强制有效期窗口(`endAt` 或 `maxDurationSeconds`,上限一年)——
  禁止无限 cron。
- **运行记录**:每次触发产出一条持久记录(`<job>#<seq>`),每 job 保留
  `historyLimit`(默认 50)条。agent 运行是真实 DSH 会话
  (`session-<uuid>`),在 Web 面板点击即可打开原生会话回放。

## Web 面板

侧栏底部「定时任务」按钮打开覆盖面板:任务列表带状态点、下次触发倒计时、
运行中实时计时、可展开的运行历史,以及单屏创建/编辑模态(触发预设 +
自定义层;agent 预设 / 钉死模型 / 权限预设均可留空继承宿主默认;推理等级
选项直接取自该模型 provider catalog 的 `reasoning.efforts`,语义与 DSH
模型选择器一致)。

## 模型工具与技能

为所有 runtime agent 注册 `cron_create` / `cron_list` / `cron_runs` /
`cron_run_now` / `cron_enable` / `cron_disable` / `cron_delete`,并附
`cron-create` 技能(收集 → 确认 → 创建 → 验证)。只有 `manual` 来源可经
工具创建/删除;其他来源可运行、可暂停、可查看。工具结果一律回显绝对 ISO
时间——模型不做时间数学。

## 投递(v1.0:command)

对 job 配置 `delivery: { kind: 'command', argv: [...], onFailureOnly?: true }`
(经 API 或工具创建),每次运行结束后会把运行记录 JSON 通过 stdin 喂给该
进程——默认仅失败时触发。

## 配置(`cron` namespace,cordis patch)

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `historyLimit` | 50 | 每 job 保留运行记录数 |
| `tickIntervalMs` | 15000 | 调度 tick 周期(≥ 1000) |
| `maxConcurrentRuns` | 0 | 全局并发上限;0 = 不限 |

`sessionGc` 在 v1.0 接受但**不生效**:自动删除持久会话日志属于破坏性操作,
cron 运行会话会一直保留,待 v1.2 GC 面板再启用。

## 持久化

状态存放在 `cron` storage domain(默认 json 后端即
`$DSH_HOME/storages/cron.json`),绝不写会话事件日志。卸载插件保留数据,
重装自动 rehydrate。彻底清除:

```bash
rm "$DSH_HOME"/storages/cron.json
```

## 说明与边界

- 进程不存活即不触发(不做系统 crontab 桥接)。
- Web 写接口只接受 `application/json` 且同源的请求。
- v1.0 提供 manual 任务来源;声明式 `config.jobs`、
  `ctx.cron.registerJob` 插件服务、callback 任务与原生企微投递通道见设计
  文档 v1.1 分期。
