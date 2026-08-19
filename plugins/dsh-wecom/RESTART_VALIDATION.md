# dsh-wecom 插件 — 重启与端到端验证操作清单

目标：让 `@dsh-plugins/dsh-wecom` 插件随 DSH web 加载，把企微智能机器人长连接
桥接到 DSH agent 会话（有对话记忆）。

## 前置（已完成 ✅，无需再动）
- 插件已构建到 `lib/`，单测通过
- 已安装进 `~/.dsh/profiles/web/node_modules/@dsh-plugins/dsh-wecom`
- `~/.dsh/profiles/web/package.json` 的 `bundles` 已含 `@dsh-plugins/dsh-wecom`
- `~/.dsh/profiles/web/cordis.patch.yml` 已 insert `dsh-wecom`（读 env 的 botId/botSecret）

## 机器人凭据（重启时注入）
```
WECOM_BOT_ID=<你的机器人Bot ID>
WECOM_BOT_SECRET=<你的机器人Secret>
```
> ⚠️ 请用你在企微后台拿到的真实 Bot ID / Secret 替换上面的占位符。
> 插件从 `process.env.WECOM_BOT_ID / WECOM_BOT_SECRET` 读取。请勿把真实凭证写进会公开提交的文件。

## 重启步骤

### 方式 A：手动重启（推荐，最可控）
1. 先停当前 DSH（你平时如何停 3180 就怎么停；launchd 服务名为 `io.onlyservice.dsh-web`）
2. 确保没有其它进程占用机器人的长连接
   ```bash
   ps aux | grep -E "bridge_wecom_dsh|listen_test" | grep -v grep   # 应为空
   ```
3. 带 env 启动 DSH：
   ```bash
   export WECOM_BOT_ID=<你的机器人Bot ID>
   export WECOM_BOT_SECRET=<你的机器人Secret>
   # 用你平时启动 3180 的命令（dsh web --host 127.0.0.1 --port 3180）
   ```
4. 观察启动日志里是否有：
   - `[dsh-wecom]` 相关日志（若 botId/botSecret 缺失会打 "plugin disabled"）
   - SDK 的 "Authentication successful"

### 方式 B：改造 launchd plist 注入 env
在 plist 的 `<EnvironmentVariables>` 里加 `WECOM_BOT_ID` / `WECOM_BOT_SECRET`，
然后 `launchctl bootout` + `launchctl bootstrap`（或 `kickstart -k`）。

## 端到端验证
重启后，企微里给「王慧卿的机器人」发消息，预期：
1. 机器人**自动回复**（agent 处理）
2. 连续发两条，第二条能**记住第一条**的上下文（对话记忆）→ 证明复用同一 agent 会话
3. （可选）在 DSH 里让 agent 调用 `wecom_send_message` 工具主动发企微

## 排障
- 机器人不回复：确认没别的进程占长连接、botId/secret 正确注入、机器人仍是长连接 API 模式
- 日志看不到插件：检查 `dump-config` 是否含 dsh-wecom、bundle 是否正确加载
- agent 不工作：确认 DSH 有可用的模型选择（agentDefaultModel）与凭证

## 备注
- 当前记忆为**进程内**：DSH 重启后企微会话上下文重置（后续可加 JSONL 持久化 + `agents.resume`）
- 一个机器人同一时间仅一个长连接；插件需与 GUI 同进程运行（本设计如此）
