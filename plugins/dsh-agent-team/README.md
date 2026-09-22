# dsh-agent-team

Team router for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): the current session model acts as **leader** and gets one global model-facing tool, `team_delegate`. Hand it a self-contained task and the plugin asks **jev** (TypeSafe System One) to judge the task's complexity and the right executor:

- **Simple tasks** (reading/writing/organizing documents, batch mechanical edits, formatting, summaries) are routed to a cheap **worker** model (default `ds-haitian/deepseek-v4-flash-0731` with `reasoningEffort: high`, privately hosted, free) via a one-shot subagent.
- **Complex tasks, low-confidence verdicts, unknown executors, or any downstream failure** return a `leader` / `fallback-leader` decision — the leader does the task itself. **Fail-open: the task is never blocked.**

Design document: [DESIGN.md](./DESIGN.md) (Chinese). 中文文档见 [README.zh.md](./README.zh.md)。

## Install

```sh
dsh plugin --profile web dlx 'github:shiliai/dsh-plugins#path:/plugins/dsh-agent-team'
```

Requires a TypeSafe API key in `JEV_API_KEY` (read from `process.env`, or override via cordis config `apiKey`). Without a key every call fails open to the leader.

## Config (all optional, defaults shown)

```yaml
# cordis.patch.yml / plugin config
config:
  # apiKey: null                       # default process.env.JEV_API_KEY
  # jevModel: 'jev-latest'
  # workers:
  #   - name: local-deepseek
  #     provider: ds-haitian
  #     model: deepseek-v4-flash-0731   # declares reasoningEfforts in settings
  #     reasoningEffort: high             # pinned so the worker route is decoupled from the leader effort
  #     description: '私有化部署的 DeepSeek,免费;适合读/写/整理文档、摘要、格式化、批量机械修改等自包含简单任务'
  # minConfidence: 0.6                  # below this the task stays with the leader
  # complexityThreshold: 2              # score 0-4, >= threshold stays with the leader
  # subagentProvider: spawn
  # maxDepth: 0                         # dropped automatically if the provider lacks the depthLimit capability
  # jevTimeoutMs: 10000
  # timeoutMs: 600000                   # whole-tool cooperative timeout
  # statsFile: ~/.dsh/agent-team/routing-stats.jsonl   # null disables
```

Routing stats (one JSON per line: task, verdict, decision, worker, durations, error) are appended best-effort and never fail a delegation.

## Development

```sh
pnpm install
pnpm release:check        # typecheck + vitest + build + pack verification
```

Dev hot loop on the 5280 sandbox (keep the `lib/` inode so cordis-plugin-hmr keeps watching):

```sh
DSH_DEV_HOT_LOOP=1 pnpm build
```

## Notes and limitations

- `maxDepth` requires the subagent provider's `depthLimit` capability; when `start()` rejects with a capability error the tool retries once without `maxDepth` (the check runs before any child exists).
- Whether the leader proactively uses the tool depends on the tool description quality; v1 accepts this.
- Non-goals (v2+): automatic per-message routing, client UI, parallel worker fan-out, worker-result verification cascades.
