# dsh-agent-team v2 设计文档 —— 从「自由文本委派」到「类型化任务契约」

> 状态:设计草案(2026-09-23),待评审;评审通过后按里程碑实施。
> 前置:v1(0.1.0)已上线,见 `DESIGN.md`;v2 目标版本 `0.2.0`(兼容新增,`team_delegate` 行为不变)。

## 0. 一句话

v1 用 jev 判断"这个自由文本任务简不简单";v2 把"值得派发"从**模型判断**下沉为**架构保证**——类型化任务契约(Task Contract)在接口层面锁定规格完整性与结果可验证性,再配上批量分片、分层路由大脑和验收-重试-升级闭环。

## 1. 动机:v1 的五个结构性缺口

来自 v1 生产数据(3 条 routing-stats)与实测教训:

| # | 缺口 | 实证 |
|---|---|---|
| 1 | **规格完整性无保证**:`team_delegate(task: string)` 收自由文本,leader 写得含糊,worker 就含糊执行 | worker prompt 只有一层前缀兜底 |
| 2 | **结果无验收**:worker 输出原样返回,leader 必须人肉复核——验收成本吃掉派发收益 | `tool.ts` 直接 `outputText(result.output)` 返回 |
| 3 | **每次派发都打 jev**:重复任务反复判定,1-2s 延迟在关键路径上 | jev 在 `execute` 第一步 |
| 4 | **统计只积累不回流**:stats.jsonl 记了决策,但从不影响后续路由 | `appendStats` 只写不读 |
| 5 | **无批量扇出**:翻译 20 个文件只能一次派一个;worker 能力事故(UNSUPPORTED_REASONING_EFFORT)每次都在 spawn 时才发现 | v1 单 worker 一次一任务 |

判据(来自路由讨论的结论,构成 v2 的设计公理):

> 派发值得当且仅当:**规格可一句话写全**(spec completeness)、**结果可机器验收**(verifiability)、**影响半径有界**(blast radius)、**批量放大收益**(batch economics)。
> v2 的做法:把这四条从"jev 的判断依据"变成"契约接口的结构属性"。

## 2. 总体架构

六层,自上而下单向依赖,统计反馈环是唯一的反向边:

```
┌────────────────────────── 工具层 (tool.ts) ──────────────────────────┐
│ team_task(kind, input)   team_delegate(task) [v1 兼容]   team_stats │
└──────┬───────────────────────────────────────────────────────────────┘
┌──────▼─────────────── 路由大脑 (brain.ts) ───────────────────────────┐
│ 契约策略 → 影响半径门 → 熔断先验 → 判定缓存 → jev → fail-open        │
│        (typed 任务不走 jev;freeform 任务仍走)                        │
└──────┬───────────────────────────────────────────────────────────────┘
┌──────▼─────────────── 契约注册表 (contracts/) ───────────────────────┐
│ translate | extract | bulk-edit | run-checks | summarize | fmt-conv  │
│ 每个契约: inputSchema / outputSchema / spec() / verify() / policy    │
└──────┬───────────────────────────────────────────────────────────────┘
┌──────▼─────────────── 执行引擎 (executor.ts) ────────────────────────┐
│ 能力记忆选工 → preflight → spawn(outputSchema 约束) → 预算控制       │
│ 验收门: schema 校验 → 语义校验 → 有界重试 → 升级                     │
│ 扇出协调 (fanout.ts): 分片 → 有界并行 → 确定性合并 → 部分成功        │
└──────┬───────────────────────────────────────────────────────────────┘
┌──────▼─────────────── 统计与反馈 (stats.ts v2) ──────────────────────┐
│ jsonl 追加(不进关键路径) → 滚动聚合 → 熔断先验/能力记忆 冷却        │
└───────────────────────────────────────────────────────────────────────┘
        外部: jev API(HTTP) · worker 子代理(subagents.start) · 文件系统
```

## 3. 核心抽象:TaskContract

```ts
interface TaskContract<I, O> {
  kind: string                    // 注册表键,如 'translate'
  title: string
  inputSchema: JSONSchema         // team_task 入参校验(结构层第一道门)
  outputSchema: JSONSchema        // worker 输出的结构契约
  blastRadius: 'read-only' | 'workspace-write' | 'external-effect'

  /** 规格编译器:类型化输入 → 完整 worker prompt。leader 填表,不写散文。 */
  spec(input: I): ContentBlock[]

  /** 语义验收(结构校验由引擎自动做):pass | fail(reasons) | partial。 */
  verify?(input: I, output: O): Promise<VerifyReport>

  /** 批量声明:输入是否可分片、如何分片。 */
  shardable?: { itemsKey: keyof I & string; shardSize: number }

  defaultPolicy: { route: 'worker' | 'leader' | 'auto'; worker?: string; effort?: string }
  budget: { maxToolCalls?: number; timeoutMs?: number; maxTokens?: number }
  retries: number                 // 验收失败后的重试预算,默认 1
}
```

两条平台事实(v1 已核实,见 `DESIGN.md` §2)在 v2 被正面利用:

1. **`SubagentStartRequest.outputSchema`** —— spawn 时直接把 `outputSchema` 交给子代理运行时,worker 的最终输出受 schema 约束(结构校验前移到平台层,引擎再做语义校验);
2. **`agentOptions` preflight 抛错** —— route 非法在 `start` 时即失败,v2 把这类错误分类写入能力记忆,冷却期内不再选中该 (worker, effort) 组合。

### 3.1 内置契约(首批)

| kind | 输入 | 输出 | 语义验收 | blastRadius | 默认路由 |
|---|---|---|---|---|---|
| `translate` | `{texts[], targetLang, style?}` | `{translations[]}` | 条数一致、非空、语言抽检 | read-only | worker |
| `extract` | `{files[], fields(schema)}` | `{records[]}` | schema 覆盖率、每文件至少一条或显式 miss | read-only | worker |
| `bulk-edit` | `{edits[], paths[], dryRun}` | `{changes[]}` | dryRun 先行;应用后 `run-checks` 通过才算 pass | workspace-write | worker |
| `run-checks` | `{check(alias)}` — 只接受配置白名单别名 | `{passed, summary, logTail}` | **退出码即验收**(命令是确定性校验器) | read-only(白名单内) | worker |
| `summarize` | `{source(text\|files[]), maxWords}` | `{summary}` | 词数上限、要点覆盖率抽检 | read-only | worker |
| `format-convert` | `{files[], toFormat}` | `{outputs[]}` | 转换器退出码 + 输出可解析 | workspace-write | worker |
| `freeform` | v1 `team_delegate` 的包装 | 原文本 | 无(语义无法机器验收) | 视任务 | **auto → jev** |

关键设计:**`run-checks` 的命令只接受配置白名单别名**(如 `checks: {typecheck: 'pnpm typecheck'}`),不接受自由命令——把"外部效应"锁进窄接口,这是影响半径可控的前提。

### 3.2 验收门与升级(状态机)

```
pending → spec编译 → spawn → worker完成
   → 结构校验(平台 outputSchema + 引擎复验)
     ├─ pass → 语义验收 verify()
     │          ├─ pass → 返回 leader(带验收报告)
     │          └─ fail → 重试预算内? 把失败原因拼回 prompt 重跑
     │                     └─ 预算耗尽 → 升级 fallback-leader
     └─ fail → 同上(结构失败也是失败信号)
升级负载 = {failure, verifyReport, worker原始输出} —— leader 收到的是诊断,不是垃圾。
```

- 重试预算默认 1(契约可覆盖);重试 prompt = 原 spec + 验收失败明细 + "修复后重新输出完整结果";
- **部分成功不丢弃**:扇出场景下,通过的分片结果照常返回,失败分片单独列出,leader 可只补做失败部分。

### 3.3 批量扇出

- 输入含数组且契约声明 `shardable` → 按 `shardSize`(默认 8 项)分片;
- 有界并行(默认 `maxConcurrency: 3`,配置上限);分片间独立重试;
- 合并保持确定性(按原顺序);
- 合并后再过一次整体语义验收(如翻译条数 == 输入条数);
- 扇出是 `team_task` 的输入形态,不单独开工具。

### 3.4 分层路由大脑(替换 v1 单次 jev)

按序取第一个有结论的层,每层结论都记录来源(`tier` 字段):

| 序 | 层 | 判什么 | 延迟 |
|---|---|---|---|
| 1 | **契约策略** | typed 契约自带 `route`(内置契约几乎都是 worker 形);`auto` 才继续 | 0(本地) |
| 2 | **影响半径门** | `blastRadius` > `maxDelegableBlastRadius`(默认 workspace-write)→ leader;external-effect 恒 leader | 0 |
| 3 | **熔断先验** | 近窗口内 (kind × worker) 验收通过率 < 阈值(默认 0.7,样本 ≥10)→ leader + 告警 | 0 |
| 4 | **判定缓存** | hash(kind + 输入骨架 + workers 指纹) 命中 → 复用;TTL 默认 1h | 0 |
| 5 | **jev** | 仅 `freeform` 与 `auto`:复杂度 + 执行者,阈值同 v1 | 1-2s |
| 6 | **fail-open** | 任何层异常 → leader,永不阻塞 | 0 |

效果:**typed 任务不再为路由付 jev 延迟**;jev 退守到它真正擅长的自由文本判定。

### 3.5 工人池与能力记忆

- `workers: [{name, provider, model, effort?, description, costHint?}]`(v1 结构 + costHint);
- 契约级 worker 覆盖(如 translate → 最便宜、bulk-edit → 代码能力强的);
- **能力记忆**持久化于 `~/.dsh/agent-team/worker-health.json`:spawn 错误分类(`UNSUPPORTED_REASONING_EFFORT` / model-not-found / provider down)→ 标记 (worker, 契约或 effort) 不健康 + 冷却期(默认 30min);选工时跳过冷却中的组合;
- 选工顺序:契约覆盖 → 健康且有能力 → 近期失败率低 → costHint 低;
- v1 的 reasoningEffort 事故从"每次 spawn 时发现"变为"一次发现,冷却期内不再踩"。

### 3.6 统计 v2 与反馈环

记录 schema(v1 字段全保留,新增):

```jsonc
{ "ts": "...", "tool": "team_task", "kind": "translate", "inputDigest": "sha256:…",
  "tier": "contract|radius|breaker|cache|jev|fail-open",
  "route": "worker|leader|fallback-leader", "worker": "local-deepseek",
  "verify": { "schema": "pass", "semantic": "pass", "retries": 0 },
  "fanout": { "shards": 3, "passed": 3, "failed": 0 },
  "durationMs": { "total": 4120, "jev": 0, "workers": 3900 },
  "usage": { "input_tokens": 0, "output_tokens": 0 }, "error": null }
```

- 追加写不进关键路径(失败只 warn,同 v1);
- 滚动聚合按 (kind, worker, tier):通过率、均时、p95、节省估算(costHint × token 差);
- 聚合喂给第 3 层熔断先验——**统计从"只写不读"变成路由输入**;
- `team_stats({groupBy, window, limit})` 供 leader/用户查询。

## 4. 工具面

| 工具 | 入参 | 说明 |
|---|---|---|
| `team_task` | `{kind, input, options?{worker?, dryRun?, maxConcurrency?, retryBudget?}}` | 主入口;批量输入自动扇出 |
| `team_delegate` | `{task, label}` | **v1 兼容,签名不变**;内部包装为 `freeform` 契约,恒走 jev 层 |
| `team_stats` | `{groupBy: 'kind'\|'worker'\|'tier', window, limit?}` | 观测面 |

三者仍经 `ctx.tools.register` 注册到全局层(平台事实同 v1)。

## 5. 配置(v2 新增,全部可选;缺省 = v1 行为 + 内置契约默认)

```yaml
agentTeam:
  workers: [...]                      # v1
  contracts:                          # 契约级策略覆盖
    translate: { worker: local-deepseek, retries: 1 }
    bulk-edit: { worker: coder-cheap, blastRadius: workspace-write }
  fanout: { shardSize: 8, maxConcurrency: 3 }
  routing:
    verdictCache: { ttlMs: 3600000, maxEntries: 500 }
    circuitBreaker: { minSamples: 10, minPassRate: 0.7, cooldownMs: 1800000 }
    maxDelegableBlastRadius: workspace-write   # external-effect 恒不可委派,此项管不到它
  checks:                             # run-checks 白名单(没有别名 = 不可运行)
    typecheck: 'pnpm typecheck'
    test: 'pnpm test'
  budget: { defaultMaxToolCalls: 30, defaultTimeoutMs: 600000 }
  healthFile: '~/.dsh/agent-team/worker-health.json'
```

## 6. 模块与文件

```
src/
  index.ts            # 装配:config → registry → brain → executor → tools
  config.ts           # v2 校验(fanout/routing/checks/budget)
  contracts/
    types.ts          # TaskContract / VerifyReport / ShardPlan
    registry.ts       # 注册表 + 配置覆盖合并
    translate.ts extract.ts bulk-edit.ts run-checks.ts summarize.ts format-convert.ts freeform.ts
  brain.ts            # 分层路由(纯函数 + 缓存/熔断注入)
  executor.ts         # spawn/预算/验收门/重试/升级
  fanout.ts           # 分片/有界并行/确定性合并
  worker-health.ts    # 能力记忆(读写 worker-health.json,原子写)
  stats.ts            # v2 schema + 滚动聚合
  jev-client.ts       # 不变
  router.ts           # 保留(v1 decide 供 freeform 层复用),标 deprecated
  tool.ts             # team_delegate(不变)
  tool-task.ts        # team_task
  tool-stats.ts       # team_stats
```

## 7. 测试

- 契约:表驱动——每个内置契约的 `spec()` 快照 + `verify()` 单元(含故意失败样本);
- 大脑:层序矩阵(策略/radius/breaker/cache/jev 的命中与穿透)、缓存 TTL、熔断阈值边界;
- 执行引擎:fake SubagentGateway——结构失败/语义失败/重试成功/预算耗尽升级/stopReason 异常;
- 扇出:合并确定性、部分失败(3 片过 2)、并发上限(用延迟注入断言峰值);
- 能力记忆:错误分类 → 冷却 → 恢复;
- e2e:5280 沙箱,复用 v1 的 dsh-cron oneshot 驱动方式(简单翻译 → worker;含错路径 → 升级)。

## 8. 里程碑

| 阶段 | 内容 | 价值锚点 |
|---|---|---|
| M1 | 契约注册表 + schema 验收 + `team_task` + 验收门/升级 + stats v2 schema | 规格完整 + 可验收,补上缺口 1/2 |
| M2 | 扇出 + 合并 + 部分成功 | 批量经济学,缺口 5 前半 |
| M3 | 分层大脑(缓存 + 熔断)+ 能力记忆 + 契约级选工 | 缺口 3/4/5 后半 |
| M4 | `team_stats` + run-checks 白名单 + 文档;可选:配置声明式自定义契约 | 观测与安全收口 |

每阶段独立可发布(0.2.0 / 0.3.0 / 0.4.0 / 0.5.0),任一阶段失败不影响已上线行为。

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 契约过窄,leader 退回自己干(覆盖率低) | `freeform` 恒在;观测 per-kind 使用率,按数据扩契约 |
| worker 输出骗过 schema 但语义错 | 语义 verify 抽检 + 熔断;bulk-edit 强制 run-checks 验收 |
| 扇出放大错误(N 片全错) | 分片独立验收 + 首片失败即中止余片(快速失败,配置可关) |
| 判定缓存把错误路由固化 | TTL + 输入骨架哈希(参数变化即 miss);缓存只存 route 不存结果 |
| 能力记忆文件损坏 | 损坏即视为空(降级为无记忆),原子写 |
| jev 退场后 freeform 延迟仍在 | freeform 也可配 `route: 'worker'` 直发(信任 leader 的判断) |

## 10. 明确不做(本版)

- 每条用户消息自动拦截路由(需要 host 深度钩子,风险大收益存疑);
- worker 结果再验证 cascade(验收门单层,避免递归派发);
- client UI(命令面 `team_stats` 足够;UI 等生态成熟);
- 跨 session 的共享工人池(单 session 内有界并行已覆盖需求)。
