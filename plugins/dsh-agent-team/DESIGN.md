# dsh-agent-team 设计文档

> 状态:设计已评审(2026-09-22),开发按本文档实施。
> 作者:k3-256k(设计);实施:kimi-for-coding。

## 1. 目标

新建独立版本插件 `plugins/dsh-agent-team`(`@dsh-plugins/dsh-agent-team`,起始版本 `0.1.0`):

- 在**任何 session** 中,当前会话模型作为 **leader** 获得一个全局 model-facing 工具 `team_delegate`;
- leader 把**自包含任务**交给该工具时,插件先调用 **jev**(TypeSafe System One 模型)判断任务复杂度与适合执行者;
- 简单任务(读/写/整理文档、批量机械修改、格式化、摘要等)路由给便宜的 **worker** 模型(默认 `ds-haitian/deepseek-v4-flash-0731` + `reasoningEffort: high`,私有化部署、免费);
- 复杂任务、jev 不确定、或任何下游失败 → 交还 leader 自己执行(**fail-open,永不阻塞任务**)。

非目标(v2 以后再议):每条用户消息自动拦截路由;client UI;多 worker 并行 fan-out;worker 结果再验证 cascade。

## 2. 已验证的平台事实(实施前必读,不要重新猜测)

以下事实均已在 DSH 0.1.2-rc.1 checkout 中核实。

### 2.1 全局工具注册 —— `@deepseek-ai/dsh-tools`

- `ToolRuntime`(服务名 `tools`)的方法 `register(definition: ToolDefinition): () => void`;
- 文档原文:"Register globally or in the calling agent scope. Scoped tools shadow globals"。**host 平面插件调用即注册到 global layer,所有 session 的 agent 可见**,无需改动 agent preset;
- `ToolDefinition` 关键字段:`name`、`description`、`parameters`(JSON Schema)、`output`(mandatory canonical output declaration)、`execute(args, exec)`;
- `execute` 的第二参 `exec: ToolRunContext` 上有 `exec.agent`(调用方 Agent,可能在非 agent 上下文为 `undefined`,需防御)与 `exec.signal`(取消信号,必须转发);
- 参考实现:`dsh-tool-subagent/lib/index.js`(约 485 行 `const parent = exec.agent`)。

### 2.2 带模型路由的子代理 —— `@deepseek-ai/dsh-subagent` + `@deepseek-ai/dsh-agent`

- 服务 `subagents`(`SubagentRuntime`):`start(name: string, request: SubagentStartRequest): Promise<SubagentRun>`;
- `SubagentStartRequest`:`{ label?, prompt: ContentBlock[], parent: Agent, signal: AbortSignal, agentOptions?, outputSchema?, maxDepth? }`;
- `AgentOptions`(`dsh-agent`):`{ provider?, model?, reasoningEffort?, maxTokens? }` —— in-process `spawn` provider 支持 `agentOptions`(在 child 创建前做 exact-route preflight,route 不合法会在 start 时抛错,**必须捕获**);
- run 结算:参考 `dsh-tool-subagent` 使用的 `settleRun`(从 `@deepseek-ai/dsh-subagent` 导出)与 `run.dispose()`;非 completed 的 stop reason 要映射为错误文本;
- `maxDepth` 需要 provider 的 `depthLimit` capability;spawn 应支持(若 start 时抛 capability 错误,则降级为不传并在 README 注明);
- `ContentBlock[]`:文本块 `{ type: 'text', text }`(以 `dsh-tools`/`dsh-subagent` 类型为准)。

### 2.3 jev(TypeSafe)API

- 端点:`POST https://api.typesafe.ai/v1/systemone`,`Authorization: Bearer $JEV_API_KEY`,`Content-Type: application/json`;
- 请求体:`{ state: string|object, model: "jev-latest", questions: { <id>: Question } }`;一次请求可携带多个问题,并行评判、互不可见;
- Question 三类:`noul`(yes/no,返回 0-1 概率)、`choice`(从 criteria 的 key 集合中选一个,返回 `choice` + `probabilities` + `confidence`)、`score`(有序等级,返回加权 `score` + `probabilities` + `confidence`);
- 响应:`{ model, answers: { <id>: Answer }, usage: { input_tokens, output_tokens } }`;
- 错误:401 key 无效;422 body 校验失败;429/529 需指数退避重试(SDK 默认自带,我们裸 fetch 要自己实现一次重试);
- 在线文档(权威,实施时如有出入以文档为准):https://docs.typesafe.ai/api.md 、 https://docs.typesafe.ai/primitives.md 、 https://docs.typesafe.ai/confidence.md ;skill 全文:https://raw.githubusercontent.com/typesafe-ai/skills/main/skills/typesafe-ai/SKILL.md 。

### 2.4 现有模型路由(生产 `~/.local/dsh_home/settings.yaml`)

- provider `ds-haitian`:`api: openai-completions`,`baseURL` 见生产 settings.yaml(私有化端点,不入库),models: `deepseek-v4-flash-0731`、`deepseek-v4-flash`、`qwen3.8-27b`;
- provider `ds-local`:`http://192.168.88.181:8890/v1`,同模型族;
- 即 worker 路由无需新增任何 settings,只要 provider/model 字符串。

### 2.5 凭证

- `JEV_API_KEY` 已存在于 `~/.local/dsh_home/.env`(合规命名,非 `DSH_` 前缀;dsh-app-boot 会注入 `process.env`);
- 插件默认读 `process.env.JEV_API_KEY`,也允许 cordis config 显式覆盖;**不要把 key 写进任何代码、测试 fixture 或日志**。

### 2.6 仓库包装约定(AGENTS.md 为准)

- 照抄 `plugins/dsh-reading`:`type: module`、tsdown 构建、`prepare`/`prepack` 跑 build、`files: [lib/, cordis.patch.yml, README.md, README.zh.md]`、exports 含 `./cordis.patch.yml` 与 `./package.json`;
- `repository.url = git+https://github.com/shiliai/dsh-plugins.git`,`repository.directory = plugins/dsh-agent-team`;
- peerDependencies 只声明 `@deepseek-ai/*` 类型依赖(cordis、dsh-tools、dsh-subagent、dsh-agent),版本对齐 `^0.1.2-rc.1`;
- 插件目录独立 SemVer,起始 `0.1.0`;
- 构建热循环约定:`tsdown.config.ts` 抄 dsh-reading 的 `DSH_DEV_HOT_LOOP` 模式(`clean: false`,否则文件 watcher 失效)。

## 3. 架构

```
leader(当前 session 模型)
   │ 调用 team_delegate({ task, label? })
   ▼
dsh-agent-team(host 平面全局工具)
   │ ① 组装 jev state: { task, workers: [{name, description}], leader: "当前会话模型(强但贵)" }
   │ ② POST /v1/systemone,一次请求两问:
   │    - complexity(score, 0-4 级 rubric)
   │    - executor(choice: 各 worker name + "leader")
   ▼
router(纯函数决策)
   ├─ executor === 'leader' ──────────────┐
   ├─ confidence < minConfidence ─────────┤
   ├─ complexity >= complexityThreshold ──┤→ 返回 { decision: 'leader', reason, jev }
   ├─ worker 名不在配置(幻觉防护)─────────┘   leader 收到后自己干活
   └─ 否则 → ctx.subagents.start(subagentProvider, {
               label, prompt: [text(task)], parent: exec.agent,
               signal: exec.signal,
               agentOptions: { provider, model, reasoningEffort? },
               maxDepth: 0,
             })
             await 结算 → dispose → 返回 { decision: 'worker', worker, jev, result }
             start/执行失败 → 返回 { decision: 'fallback-leader', error, jev }
   │ ③ 任何路径都追加写 routing-stats.jsonl
```

关键原则:**jev 只做判断,代码拥有流程**;所有失败路径都收敛到"交还 leader"。

## 4. 交付物清单

```
plugins/dsh-agent-team/
├── DESIGN.md                 # 本文档
├── package.json              # 按 §2.6 约定
├── tsconfig.json             # 参考 dsh-reading
├── tsdown.config.ts          # 含 DSH_DEV_HOT_LOOP(clean:false)模式
├── vitest.config.ts
├── cordis.patch.yml          # insert 一项,inject: [tools, subagents]
├── README.md / README.zh.md
├── scripts/verify-pack.mjs   # 抄 dsh-reading 的同名脚本思路
└── src/
    ├── index.ts              # name/inject/apply,config 校验,注册工具
    ├── config.ts             # Config 类型 + 默认值 + 归一化
    ├── jev-client.ts         # TypeSafe HTTP 客户端
    ├── router.ts             # 纯函数路由决策
    ├── stats.ts              # JSONL 追加日志
    └── tool.ts               # team_delegate 的 ToolDefinition
tests/ (或 src/*.test.ts,随仓库惯例)  # vitest
```

### 4.1 Config(全部可选,有默认值)

```ts
interface Worker {
  name: string            // jev choice 的 option key,如 'local-deepseek'
  provider: string        // DSH settings 里的 provider,如 'ds-haitian'
  model: string           // 如 'deepseek-v4-flash-0731'
  description: string     // 给 jev 看的能力描述(中英文均可)
  reasoningEffort?: string
}
interface Config {
  apiKey?: string | null        // 默认 process.env.JEV_API_KEY
  jevModel?: string             // 默认 'jev-latest'
  workers?: Worker[]            // 默认 [{ name: 'local-deepseek', provider: 'ds-haitian',
                                //           model: 'deepseek-v4-flash-0731', reasoningEffort: 'high',
                                //           —— 必须选 settings 中声明了 reasoningEfforts 的模型并显式固定 effort:
                                //           子代理默认继承 leader 的 reasoningEffort,目标模型未声明该 effort
                                //           会被 pi-ai 以 UNSUPPORTED_REASONING_EFFORT 拒绝(2026-09-22 sandbox 实测)
                                //           description: '私有化部署的 DeepSeek,免费;适合读/写/整理文档、摘要、格式化、批量机械修改等自包含简单任务' }]
  minConfidence?: number        // 默认 0.6
  complexityThreshold?: number  // 默认 2(score 0-4,>= 阈值即复杂)
  subagentProvider?: string     // 默认 'spawn'
  maxDepth?: number             // 默认 0
  jevTimeoutMs?: number         // 默认 10000
  timeoutMs?: number            // 工具整体超时(ToolDefinition.timeoutMs),默认 10 * 60 * 1000
  statsFile?: string | null     // 默认 '~/.dsh/agent-team/routing-stats.jsonl'(展开 ~);null 关闭
}
```

### 4.2 jev-client

```ts
interface JevVerdict {
  complexity: number        // 0-4 加权分
  executor: string          // choice 的 winner
  confidence: number        // executor 的 confidence
  usage: { input_tokens: number, output_tokens: number }
  raw: unknown              // 原始 answers,供 stats 与调试
}
async function judge(opts: {
  apiKey: string; model: string; timeoutMs: number;
  task: string; workers: Worker[];
}): Promise<JevVerdict>
```

- questions(一次请求):
  - `complexity`: `type: 'score'`,criteria 五级(0="纯读取/原样改写/格式化,无需判断",1="简单摘要或单文件小改",2="需要理解上下文的中等任务",3="多文件/多步骤推理",4="架构决策/高风险操作"),instructions 指明"评估 `task` 完成所需的判断深度";
  - `executor`: `type: 'choice'`,criteria = 每个 worker(`worker.name` → `worker.description`)+ `leader`(描述:"当前会话的主力模型,能力最强但成本高;需要对话上下文、架构判断或高风险操作的任务必须留给它")。
- 重试:429/529 时 500ms 后重试一次;其余错误直接 throw(上层 fail-open);
- 校验:响应 answers 缺字段/类型不符 → throw。

### 4.3 router(纯函数)

```ts
type Decision =
  | { route: 'leader'; reason: string }
  | { route: 'worker'; worker: Worker; reason: string }
function decide(verdict: JevVerdict, workers: Worker[], cfg: {
  minConfidence: number; complexityThreshold: number
}): Decision
```

分支顺序:① executor==='leader';② confidence < minConfidence;③ complexity >= complexityThreshold;④ executor 不在 workers(幻觉)→ leader;⑤ 命中 worker。每条 reason 写人话(进 stats 与工具返回)。

### 4.4 工具 `team_delegate`

- parameters(JSON Schema):
  - `task`: string,必填 —— "自包含的任务描述。子代理看不到本对话,必须包含完成任务所需的全部上下文(文件路径、要求、输出格式)";
  - `label`: string,可选 —— 子代理显示名。
- description 要点(中英双语一段即可):"把一个自包含任务交给团队路由器。路由器用 jev 判断任务复杂度:简单任务派给便宜的 worker 模型执行并返回结果;复杂或不确定的任务返回 `leader` 决策,此时你必须自己完成。适合:读/写/整理文档、摘要、翻译、格式化、批量机械修改。不适合:需要本对话上下文的任务、架构决策、高风险操作。"
- execute 流程按 §3;返回的 canonical value 为 JSON:
  - leader:`{ decision: 'leader', reason, jev: { complexity, confidence } }`;
  - worker:`{ decision: 'worker', worker: worker.name, jev: {...}, result: <子代理最终文本> }`;
  - fallback:`{ decision: 'fallback-leader', reason, error, jev? }`;
  - jev 不可用:`{ decision: 'leader', reason: 'jev 调用失败,fail-open', error }`。
- 返回文本(finalizeContent 或直接 content)必须在 JSON 之外附一句自然语言指令,例如 decision=leader 时:"路由结果:由你(leader)直接完成该任务,原因:…"。
- `exec.agent` 为空 → 返回错误内容(isError=true)。
- 子代理 prompt 加一行前缀,声明其 worker 身份与"只做任务、不要再委派"。

### 4.5 stats

每行一个 JSON:`{ ts, task: task.slice(0, 200), verdict?, decision, worker?, durationMs, jevDurationMs, error? }`;append 写、出错只警告不失败。

### 4.6 cordis.patch.yml

```yaml
- insert:
    - id: dsh-agent-team
      name: '@dsh-plugins/dsh-agent-team'
      inject: [tools, subagents]
      config:
        apiKey: !!js process.env.JEV_API_KEY ?? null
```

## 5. 测试(vitest)

- `jev-client`:mock global fetch —— 正常响应解析、429→重试一次成功、429→重试仍失败 throw、超时 abort、422 throw、缺字段 throw;断言请求体 questions 结构(两问、criteria 含所有 worker + leader);**不得使用真实 API key**;
- `router`:决策矩阵全覆盖(五个分支 + 边界值 confidence==minConfidence、complexity==threshold);
- `tool`:mock `ctx.tools`(捕获注册的 definition)与 `ctx.subagents`(fake start/run)——
  - leader 决策不调用 subagents;
  - worker 决策以正确 `agentOptions`(provider/model/reasoningEffort)与 `maxDepth` 调 start,`parent === exec.agent`,signal 透传;
  - start 抛错 → fallback-leader(非 isError);
  - jev 抛错 → leader fail-open;
  - exec.agent undefined → isError;
  - stats 追加写(tmpdir);
- config 归一化:默认 workers、非法阈值拒绝。

## 6. 验收(开发完成后按序执行)

1. 包内 `pnpm install && pnpm release:check` 绿;
2. 根目录 `pnpm versions:check` 绿;
3. dev sandbox:`scripts/dev-sandbox.sh --plugin dsh-agent-team`(5280;sandbox home 不复制 `.env`,需要按 AGENTS.md 方式给 sandbox 注入 `JEV_API_KEY`,或直接 config 覆盖——注意 sandbox 的 settings 也无 ds-haitian 时,验收改用 sandbox 已有的任一 provider/model 做 route 验证,或把 sandbox 的 settings 补上;以实现时实际情况为准并在报告中说明);
4. 在 5280 开新 session:确认工具目录出现 `team_delegate`;派"把 README.md 摘要成 5 句话"→ 应走 worker(子 session 的 model route 可查);派"为分布式锁设计一个容灾方案"→ 应留 leader;
5. `scripts/e2e-probe.sh --base http://127.0.0.1:5280` 绿;
6. **不要**重启生产、**不要**提交 git、**不要**改 `$DSH_HOME` 下任何文件。

## 7. 风险与备注

- 最大技术风险:preset 的 `restrict()` 可能过滤全局工具(standard preset 未见 allow-list,预期无碍);若 sandbox 验证工具不可见,备选方案是把工具注册改为经 preset 插入一行配置,或调查 tools 分层注册——先报告,不要私自改 DSH;
- `maxDepth` capability 若被 spawn 拒绝,降级为不传并在 README 注明;
- jev 每次路由约 300-400 input tokens,可接受;
- leader 是否主动调用取决于工具描述的质量,v1 接受这一点;
- 实现中对 TypeSafe API 细节有疑问时,以 https://docs.typesafe.ai/llms.txt 索引的在线文档为准。
