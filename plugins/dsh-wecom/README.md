# dsh-wecom

企业微信智能机器人(长连接) ⇄ DeepSeek Harness 双向桥接插件。

以 **DSH 插件**形式把企微智能机器人长连接常驻在 DSH 进程内，收到的企微消息注入
**同一个复用 agent 会话**（因此具备**跨消息对话记忆**），agent 的回复沿长连接实时
回发到企微会话；并注册 `wecom_send_message` 工具，让 agent 可主动向企微发消息。

除了对话，插件还在企微里提供了一组**斜杠命令**，让你能开新会话、切换工作目录、切换
定制的 Agent（DSH agent preset），并把选中的能力真正落到「这个企微会话」上。

## 为什么是长连接

- 用户给机器人发消息，企微会**主动推送到**你的本地服务（`wss://openws.work.weixin.qq.com`），
  无需公网 IP / 域名、无需付费开通「会话内容存档」。
- 相比每次冷启动（无记忆），本插件与 GUI **同进程**，复用 `ctx.agents` 里常驻的 agent，
  **有对话记忆、无冷启动延迟**。

官方文档：智能机器人长连接 https://developer.work.weixin.qq.com/document/path/101463

## 环境要求

- Node.js `^22.19.0 || >=24.0.0`、pnpm
- DSH `0.1.0-rc.6` 与 Web profile（与 GUI 同进程）
- 企微智能机器人已开启 **API 模式 + 使用长连接**，取得 **Bot ID / Secret**

## 配置

机器人凭证通过环境变量（不建议写死进 patch）：
```bash
export WECOM_BOT_ID=your-bot-id
export WECOM_BOT_SECRET=your-bot-secret
```

或在 Web profile 的用户 patch `cordis.patch.yml` 中给出 config（覆盖 `!!js process.env...`）：
```yaml
- insert:
    - id: dsh-wecom
      name: '@dsh-plugins/dsh-wecom'
      inject: [agents, agentDefaultModel, sessions, tools]
      config:
        botId: !!js process.env.WECOM_BOT_ID ?? ''
        botSecret: !!js process.env.WECOM_BOT_SECRET ?? ''
        allowChats: []          # 空=允许所有会话；非空则仅允许列出的 chatid
        defaultCwd: '/Users/chris/project/wecom-skills'   # 可省略，默认 process.cwd()
        defaultPreset: 'standard'                          # 可省略，默认 roster 默认 preste
        maxReplyChars: 20000
```

## 安装

```sh
pnpm install
pnpm run build
dsh plugin --profile web add "$(pwd)"
```

## 快速开始

1. 在企微客户端：工作台 → 智能机器人 → 「王慧卿的机器人」→ 详情，确认是 **长连接 API 模式**，
   并确认目标会话（如王慧卿单聊）在机器人可见范围。
2. 启动 DSH web（插件随 profile 加载）：
   ```sh
   dsh web
   ```
3. 在企微里给机器人发消息 → agent 处理 → 自动回复（同一会话连续对话有记忆）。

## 企微斜杠命令

| 命令 | 用法 | 作用 |
|---|---|---|
| `/help` | `/help` | 显示命令帮助 |
| `/new` | `/new` | **开启新的对话**：清空当前会话记忆，起一段全新会话 |
| `/cd` | `/cd [目录]` | **切换工作目录**：无参数显示当前目录；带参数则切过去并开新会话 |
| `/pwd` | `/pwd` | 显示当前工作目录 |
| `/agent` | `/agent [名称]` | **切换 Agent**：无参数列出可用 Agent preset 并显示当前项；带名称则切换并开新会话 |
| `/status` | `/status` | 显示 会话 id / 工作目录 / Agent / 模型 |

### 说明

- **记忆与「新对话」**：同一个企微会话默认一直复用同一个 agent（有记忆）。发 `/new` 会
  起一个新的会话 id（`wecom-<chatId>-<N>`），旧会话从此刻起不再被引用。
- **工作目录**：`/cd <dir>` 会把新会话的 agent 放到新目录（`cwd` 是会话创建事实，所以切换
  即新会话）；相对路径基于当前目录解析，支持 `~`。切换后可用 `/pwd` 确认。
- **定制 Agent**：DSH 的 agent preset（`ctx.agentPresets`）正是「为某个会话定制的一个或多个
  agent」。preset 决定该会话能看到哪些工具与提示，例如自带 `standard`（标准编码）、`minimal`
  （极简双工具）、`code`、`cordis`，也支持在 DSH 里自我复制/创作新的 preset。本插件的 agent
  在创建时会把选定的 preset **mount** 进该会话（新会话方可切换，因为已产生的会话不能换工具集）。

## 实现说明

| 文件 | 作用 |
|---|---|
| `src/bot.ts` | 包装企微官方 Node SDK `@wecom/aibot-node-sdk`，负责建连/鉴权/心跳/重连/消息归一化 |
| `src/index.ts` | 插件主体：每个企微会话一个 `ChatState`（`wecom-<chatId>-<gen>`），按会话串行队列 `followup`→`whenIdle`→聚合回复→回发；`sessions.flush` 持久化；**mount agent preset + 注入工作目录**；解析斜杠命令 |
| `src/commands.ts` | 斜杠命令解析、帮助文本、工作目录解析（可单测） |
| `src/frame.ts` | 消息提取 + 回复聚合（可单测） |
| `src/tools.ts` | 注入 `wecom_send_message` 工具（agent 主动发企微） |

- **对话记忆**：复用同一 `SessionId` 的 agent，多次 `agent.followup(...)` 在同一会话累积上下文；
  另用显式按会话 transcript 注入历史，保证 LLM 始终看到前文。
- **按会话隔离**：每个企微会话（单聊/群）有独立 agent 与记忆，多会话互不干扰。
- **多会话代际**：`/new`、`/cd`、`/agent` 会把 `generation` +1，产生新的会话 id，从而干净地
  开启一段「新会话」而不复用旧会话的历史。
- **Agent preset**：agent 创建时若可用 `agentPresets` 服务，会把 `defaultPreset`（或 `/agent`
  选定的 preset）resolve 后写入会话 header（`meta.agentPreset`），并在 `setup()` 里 `mount`，
  让该会话真正获得对应 Agent 的工具集与提示。
- 重启后如需保留记忆，可用 `ctx.agents.resume`（需 `sessionPersistence` 后端），当前以进程内
  记忆为主。

## 局限

- **记忆为进程内**：重启 DSH 后企微会话上下文重置；命令选定的目录/Agent 也在内存中。
- 一个长连接 = 一个进程；插件需与 GUI 同进程运行（本设计即如此）。
- agent 回复按轮聚合回发（非逐 token 流式）；如需流式可改监听 `assistant/chunk`。
