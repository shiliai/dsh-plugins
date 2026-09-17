# dsh-cron 插件设计（v1）

> 状态：设计草案。目标包：`plugins/dsh-cron`（`@dsh-plugins/dsh-cron`）。
>
> 定位：宿主侧（host-side）无人值守定时任务调度器，与官方
> `@deepseek-ai/dsh-schedule`（会话内持久提醒）互补——本插件的 job
> 不属于任何交互会话，进程存活期间自动触发。

## 参考方案调研结论

| 方案 | 可借鉴 | 不采用 |
| --- | --- | --- |
| squirrel20/dsh-cron | 三种 job 来源、agent/command/callback 任务类型、Web 侧栏 overlay、`ctx.storage.domain` 持久化、可靠性语义、时钟纪律 | —（作为主干） |
| fan56/dsh-cron | 循环任务强制有效期窗口（禁止无限 cron）、工具结果回显绝对时间（模型不做时间计算） | followup/steer 投递进存活会话（依赖会话在线，语义复杂） |
| Whale-Zhang/dsh-cron-tasks | 侧栏「定时任务」入口 UX、点运行记录跳转原生会话回放 | 仅会话型任务一种形态 |

## 1. 核心概念

- **Job**：一条命名调度定义，= trigger + task + policy + 可选 delivery。
- **Trigger**（三选一）：
  - `cron`：5 字段日历表达式 + **显式 IANA `timeZone`**（永不读取进程时区）；
  - `everySeconds`：锚点对齐的固定间隔，最小 60s；
  - `at`：一次性 RFC 3339 时刻（必须带 Z 或数字偏移）。
- **Task kind**：
  - `agent`：`ctx.agents.create` 开一次性 agent，提交 prompt 走完整 dsh 工具链，等待静默后取最后一条 assistant 消息作为 summary，随后 dispose（dsh-headless one-shot 配方）；
  - `command`：spawn 子进程，记录退出码与输出尾部；
  - `callback`：仅插件来源 job 可用，同进程运行插件注册的函数。
- **Run**：一次触发产生的运行记录，key 为 `<job>#<seq>`。

## 2. Job 来源（三种，统一进同一列表）

1. **config 声明式**：profile 的 `cordis.patch.yml` 里 `config.jobs`，随 profile
   版本化；配置错误（重名、非法表达式、缺时区）在 mount 时 fail-loud。
2. **manual 运行时 overlay**：Web 侧栏 `+` 或会话内 `cron_create` 工具创建，
   持久化到 storage domain 的 `manual` 表，UI 上带 "manual" 标记；与 config
   job 同名时 config 胜出并驱逐 manual 副本。
3. **plugin 服务**：其他插件 `inject: [cron]` 后
   `ctx.cron.registerJob(spec, { owner, run? })`，安装即创建、卸载即退役；
   同步校验（坏 spec 在 provider 自己的 `apply` 里抛错并指名字段）；
   `registerJobs` 批量原子（任一坏则整体回滚）。plugin job 在 UI/工具层
   只读（可运行、暂停、查看），provider 卸载后留 orphan 行（仅可删除）。
   - 本仓库首要消费者：**dsh-wecom / dsh-obsidian / dsh-reading** 的周期
     维护任务（如笔记再索引、授权巡检）可直接以 callback job 注册。

## 3. 可靠性语义

- **at-most-once**：`lastFiredMs` 在执行前落盘。
- **misfire**：进程停机错过的节拍默认 `skip`（不逐个补跑）；`runOnce`
  仅对最近一次到期补跑一次。借鉴 fan56：cron 语义是"在时刻 X 执行"，
  不复活过期工作。
- **overlap**：`skip | queue | replace`（queue 深度为 1，只保留最新被挤掉的
  那一次）。
- **崩溃修复**：启动时将中断的 running 记录修复为 `aborted`。
- **时钟纪律**：长等待分段 sleep，每次唤醒重读墙钟——回拨不提前触发，
  跳变按逾期处理。
- **有效期窗口**（吸收 fan56 ADR 0006）：循环任务必须携带
  `maxDurationSeconds` 或 `endAt` 之一，上限一年；到期自动归档。
  一次性任务触发后自归档。

## 4. 执行与交付

- agent 运行注入固定 `[CRON RUN]` framing（无人值守、禁止提问），作为
  scoped system-prompt 段注入；宿主无 system-prompt 服务时降级为消息前缀。
- 工具结果一律回显绝对 ISO 时间（`now` / `nextFire`），模型不做时间数学。
- **delivery**（本仓库差异化点）：
  - `command`：运行记录 JSON 喂 stdin，默认仅失败时触发；
  - `wecom`：通过 dsh-wecom 已装实例把 summary 投递到指定 chat
    （v1 可先只支持 command delivery + 文档给出 wecom notify 脚本，
    原生 wecom 通道列为 v1.1）。

## 5. 模型面工具与 Skill

注册到所有 runtime agent：

| 工具 | 作用 |
| --- | --- |
| `cron_create` | 创建 manual job（仅 `cron`/`everySeconds`/`at` + agent/command） |
| `cron_list` / `cron_runs` | 列出 job / 运行历史 |
| `cron_run_now` / `cron_enable` / `cron_disable` | 立即运行 / 暂停恢复 |
| `cron_delete` | 删除 manual job |

附 `cron-create` skill（收集→确认→创建→验证），宿主有 skill registry 时
自动注册。config/plugin job 对工具层可见可操纵但不可创建/删除。

## 6. Web UI（client overlay）

- 侧栏脚时钟徽章 + Cron Jobs 区：状态点（上次结果）+ 下次触发时间 + 运行中
  实时计时；行展开运行历史。
- 点 agent run 跳转该 run 的完整会话回放；点 command run（或会话已清理的
  agent run）打开中栏 run-detail 页（状态/时长/退出码/argv/输出尾）。
- 创建/编辑模态单屏完成：触发预设（每小时/每天/工作日/每周）+ 自定义层
  （cron 表达式/间隔/一次性），任务类型、**agent 预设 / model / permission**
  （三者留空均继承宿主默认）——agent 预设即 `ctx.agents.create` 的 preset，
  决定该次运行的系统人格、默认工具集与权限基线（如 code-reviewer /
  researcher / ops-bot）；model 钉死后不跟随聊天选择器变化，额度可预期；
  **推理等级（reasoningEffort）随模型联动**，语义与 DSH 模型选择器一致：
  取值来自该模型 provider catalog 的 `reasoning.efforts`（含 id/name/
  description 与 `defaultEffort`），空值 = 跟随 provider 默认
  （`effort.providerDefault`）；模型留空继承或该模型无推理等级时
  （"This model provides no reasoning effort levels."）该项禁用——
  工作目录浏览、超时、overlap/misfire 策略；时区静默取浏览器值
  （编辑时保留 job 原值）。
- host 半侧：`GET /dsh-cron/api/state` + 写接口要求 `application/json`
  （挡跨站 simple request）；仅在 webServer 存在时注册路由，headless
  profile 原样可挂载。

## 7. 持久化

`ctx.storage.domain('cron')`，绝不写会话事件日志：

- `jobs` 表（manual overlay）、`runs` 表（每 job 保留 `historyLimit`，
  默认 50）；原子写（tmp + fsync + rename），损坏文件跳过不致命。
- 卸载插件保留数据（重装可 rehydrate），文档给出 `rm -r` 清除路径。

## 8. 配置面（`cron` namespace）

| Key | 默认 | 含义 |
| --- | --- | --- |
| `historyLimit` | 50 | 每 job 保留运行记录数 |
| `tickIntervalMs` | 15000 | 调度 tick 周期 |
| `maxConcurrentRuns` | 0（不限） | 全局并发上限；job 自身重叠由 `policy.overlap` 管 |
| `jobs` | [] | config 声明式 job 列表 |
| `sessionGc` | 开启 | cron agent 会话清理（graceMinutes 默认 30） |

配置纪律遵循仓库 AGENTS.md：禁用 `DSH_` 前缀环境变量；密钥入
`$DSH_HOME/.credentials.yaml` refs；插件自有前缀 `CRON_*`。

## 9. 打包与仓库规约

- 目录 `plugins/dsh-cron`，包名 `@dsh-plugins/dsh-cron`，独立 SemVer；
  release tag `dsh-cron-v<version>`；发布前过 `release:check` 与根
  `pnpm versions:check`。
- 安装：`dsh plugin --profile web add github:shiliai/dsh-plugins#path:/plugins/dsh-cron`；
  `prepare` 脚本产出 `main`/`exports`/`./client` 声明的全部文件；
  `cordis.patch.yml` 按 dsh-wecom 同款 `- insert` 形式（inject:
  `tools, agents, sessions, webServer, storage`），客户端经
  `exports["./client"]` + `dsh.client` 字段。
- 测试：vitest 单测（cron 解析、时区、锚点对齐、misfire 合并、store
  原子写）；`scripts/smoke-boot.mjs`（pack → 临时 profile → 真机 boot）。

## 10. 分期

- **v1.0**：cron/everySeconds/at 三种触发；agent + command 任务；manual
  overlay + 侧栏 UI + 运行历史会话跳转；overlap/misfire/at-most-once/崩溃
  修复/时钟纪律；`cron_*` 工具 + cron-create skill；command delivery。
- **v1.1**：plugin 服务（`ctx.cron.registerJob` + callback 任务）；
  dsh-wecom 原生投递通道；config 声明式 jobs。
- **v1.2**：会话 GC 面板、orphan job 管理完善、任务统计视图。

## 11. 典型场景验证

两个目标用例均在 v1.0 能力内（agent 任务走完整 dsh 工具链，skill 与
已装插件的工具可直接调用），v1.1 后可用 config 声明或原生投递通道简化。

### 场景 A：每天 8 点总结企微未读邮件并推送到企微

```yaml
# cordis.patch.yml（v1.1 config 声明式；v1.0 用 cron_create / 侧栏 + 等价创建）
- id: dsh-cron
  config:
    jobs:
      - name: wecom-mail-digest
        schedule: { cron: "0 8 * * *", timeZone: "Asia/Shanghai" }
        task:
          kind: agent
          prompt: >
            使用 wecom 技能查看我的企业微信未读邮件，按重要性归类总结
            （发件人/主题/要点/建议动作），然后调用 wecom_send_message
            把总结推送到我的企微单聊。无未读时回复"今日无未读邮件"。
          timeoutSeconds: 600
        policy: { overlap: skip, misfire: skip }
        endAt: "2027-12-31T23:59:59+08:00"
```

- 依赖：dsh-wecom 已安装（提供 `wecom_send_message` 与邮件能力）。
- v1.0：agent 自行调 `wecom_send_message` 完成推送；v1.1 可改为 agent
  只产出 summary、由 `delivery.wecom` 原生通道投递（与任务逻辑解耦，
  失败可重试/告警）。

### 场景 B：定时巡检多个仓库的 open PR / issue，分配给 agent 处理

```yaml
- id: dsh-cron
  config:
    jobs:
      - name: repo-triage
        schedule: { cron: "0 9,15 * * 1-5", timeZone: "Asia/Shanghai" }
        task:
          kind: agent
          prompt: >
            对 shiliai/dsh-plugins、shiliai/dsh-reading 两个仓库执行
            `gh pr list --state open` 与 `gh issue list --state open`，
            过滤掉已指派和 draft；对每个可处理项调用 subagent 工具开一个
            后台 agent 处理（修复/评审/回复），最后汇总本次分派结果。
          cwd: /path/to/workspaces
          timeoutSeconds: 1800
        policy: { overlap: skip, misfire: runOnce }
        endAt: "2027-12-31T23:59:59+08:00"
```

- cron agent 是一次性 root agent，`subagent` 工具可用——"分配给 agent
  处理"即由它扇出后台子 agent，各自独立上下文处理单个 PR/issue。
- 仓库较多或处理耗时时，建议每仓库一个 job 错峰（分散 quota 与故障面）。
- 需要人在回路的项（如合并决策）可在 prompt 里约定只出建议、经
  delivery 推送后由人确认。

## 12. 明确不做

- 不投递进存活交互会话（fan56 的 followup/steer 模式）——v1 每次触发
  一律新开一次性 agent，语义简单且 Host 有 profile 即可触发。
- 不做系统 crontab 桥接；进程不存活即不触发（文档明示）。
- 不支持无有效期窗口的无限循环任务。
