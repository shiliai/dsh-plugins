# dsh-wecom

企业微信智能机器人(长连接) ⇄ DeepSeek Harness 双向桥接插件。

以 **DSH 插件**形式把企微智能机器人长连接常驻在 DSH 进程内，收到的企微消息注入
**同一个复用 agent 会话**（因此具备**跨消息对话记忆**），agent 的回复沿长连接实时
回发到企微会话；并注册 `wecom_send_message` 工具，让 agent 可主动向企微发消息。

## 为什么是长连接

- 用户给机器人发消息，企微会**主动推送到**你的本地服务（`wss://openws.work.weixin.qq.com`），
  无需公网 IP / 域名、无需付费开通「会话内容存档」。
- 相比之前方案 A（每次冷启动 `dsh --profile headless`、无记忆），本插件与 GUI **同进程**，
  复用 `ctx.agents` 里常驻的 agent，**有对话记忆、无冷启动延迟**。

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
        allowChats: []   # 空=允许所有会话；非空则仅允许列出的 chatid
        busyReply: '（上一句还在处理，请稍等片刻）'
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

## 实现说明

| 文件 | 作用 |
|---|---|
| `src/bot.ts` | 包装企微官方 Node SDK `@wecom/aibot-node-sdk`，负责建连/鉴权/心跳/重连/消息归一化 |
| `src/index.ts` | 插件主体：`agents.create` **每个企微会话各建一个**并复用（`SessionId('wecom-<chatId>')`，会话间隔离），按会话串行队列 `followup`→`whenIdle`→聚合回复→回发；`sessions.flush` 持久化 |
| `src/frame.ts` | 消息提取 + 回复聚合（可单测） |
| `src/tools.ts` | 注入 `wecom_send_message` 工具（agent 主动发企微） |

**对话记忆**：复用同一 `SessionId` 的 agent，多次 `agent.followup(...)` 在同一会话累积上下文。
**按会话隔离**：每个企微会话（单聊/群）有独立 agent 与记忆，多会话互不干扰。
重启后如需保留记忆，可用 `ctx.agents.resume`（需 `sessionPersistence` 后端），当前为进程内记忆。

## 局限

- **记忆为进程内**：重启 DSH 后企微会话上下文重置（后续可加 JSONL 持久化 + `resume`）。
- 一个长连接 = 一个进程；插件需与 GUI 同进程运行（本设计即如此）。
- agent 回复按轮聚合回发（非逐 token 流式）；如需流式可改监听 `assistant/chunk`。
