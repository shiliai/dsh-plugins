# dsh-agent-team

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 团队路由器插件:当前会话模型作为 **leader**,获得一个全局 model-facing 工具 `team_delegate`。把自包含任务交给它,插件调用 **jev**(TypeSafe System One)判断任务复杂度与适合执行者:

- **简单任务**(读/写/整理文档、批量机械修改、格式化、摘要等)路由给便宜的 **worker** 模型(默认 `ds-haitian/deepseek-v4-flash-0731` + `reasoningEffort: high`,私有化部署、免费),经一次性子代理执行并返回结果;
- **复杂任务、jev 不确定、执行者不在配置中、或任何下游失败** → 返回 `leader` / `fallback-leader` 决策,由 leader 自己完成。**fail-open,永不阻塞任务。**

设计文档:[DESIGN.md](./DESIGN.md)。

## 安装

```sh
dsh plugin --profile web dlx 'github:shiliai/dsh-plugins#path:/plugins/dsh-agent-team'
```

需要 TypeSafe API key:放在 `JEV_API_KEY` 环境变量(插件默认读 `process.env`),或用 cordis config `apiKey` 显式覆盖。没有 key 时所有调用都 fail-open 交还 leader。

## Config(全部可选,注释为默认值)

```yaml
config:
  # apiKey: null                       # 默认 process.env.JEV_API_KEY
  # jevModel: 'jev-latest'
  # workers:
  #   - name: local-deepseek
  #     provider: ds-haitian
  #     model: deepseek-v4-flash-0731   # 该模型在 settings 中声明了 reasoningEfforts
  #     reasoningEffort: high             # 显式固定,避免继承 leader 的 effort 被目标模型拒绝
  #     description: '私有化部署的 DeepSeek,免费;适合读/写/整理文档、摘要、格式化、批量机械修改等自包含简单任务'
  # minConfidence: 0.6                  # 低于此信心则交还 leader
  # complexityThreshold: 2              # score 0-4,>= 阈值交还 leader
  # subagentProvider: spawn
  # maxDepth: 0                         # provider 无 depthLimit capability 时自动降级为不传
  # jevTimeoutMs: 10000
  # timeoutMs: 600000                   # 工具整体协作超时
  # statsFile: ~/.dsh/agent-team/routing-stats.jsonl   # null 关闭
```

每次路由追加一行 JSON 统计(task、verdict、decision、worker、耗时、错误),写失败只警告不影响任务。

## 开发

```sh
pnpm install
pnpm release:check        # typecheck + vitest + build + 打包验证
```

5280 sandbox 热循环(必须保持 `lib/` 目录 inode,cordis-plugin-hmr 才能持续监听):

```sh
DSH_DEV_HOT_LOOP=1 pnpm build
```

## 备注与限制

- `maxDepth` 依赖 subagent provider 的 `depthLimit` capability;`start()` 抛 capability 错误时自动重试一次不传 `maxDepth`(capability 校验发生在创建任何子代理之前,重试安全)。
- leader 是否主动调用该工具取决于工具描述质量,v1 接受这一点。
- 非目标(v2 以后再议):每条用户消息自动拦截路由、client UI、多 worker 并行 fan-out、worker 结果再验证 cascade。
