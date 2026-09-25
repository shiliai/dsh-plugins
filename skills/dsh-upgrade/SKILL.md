---
name: dsh-upgrade
description: Upgrade the local production dsh (DeepSeek Harness) to a new upstream release, safely — debug-instance canary, preflight + armed restart script, restart-by-the-debug-session, and automatic session wake-up. Use when the user asks to update/升级/重启 dsh, deploy a new dsh version, or restart the production dsh web host.
license: MIT
compatibility: macOS; production dsh web on :3080 (DSH_HOME=~/.dsh); source clone at ~/Project/deepseek-harness; proven on the 0.1.5-rc.2 → 0.1.7-rc.2 upgrade (2026-09-25).
---

# dsh-upgrade

把本机生产 dsh 安全升级到上游新版本。核心原则来自 `ShiLi/dsh-plugins` 的 AGENTS.md「DSH restart safety」：

- **生产宿主不能自己重启自己**：宿主被替换时，它自己发出的 tool call 永远等不到 result 持久化（TOOL_OUTCOME_UNKNOWN）。重启必须由**外部进程**执行。
- **会话日志单写者**：同一 `DSH_HOME` 上绝不能同时活两个宿主。调试实例必须用**独立 DSH_HOME**；旧进程必须完全停止、端口完全释放后才能起新进程。
- **两段式**：先完成所有可持久化的准备（源码、预装、脚本、报告），再外部重启，最后在新请求里核验。

## 本机事实（2026-09-25 基准，变动时先核实）

| 项 | 值 |
|---|---|
| 生产宿主 | `node /opt/homebrew/bin/dsh web --port 3080 --no-open`，detached，PPID 1 |
| 生产 home | `~/.dsh`（默认，无特殊 env）；profile `~/.dsh/profiles/web` |
| 生产端口 | 3080（UI: `http://127.0.0.1:3080`） |
| 全局安装 | `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh`（npm -g，prefix /opt/homebrew） |
| 源码 clone | `~/Project/deepseek-harness`（upstream: github.com/deepseek-ai/deepseek-harness） |
| 调试实例 | :5280，`DSH_HOME=~/.local/dsh-home-dev`（生产 home 的 APFS 克隆） |
| 重启脚本模板 | 本仓库 `skills/dsh-upgrade/assets/restart-prod-v2.sh`（部署时复制到 `~/Project/dsh-update-staging/` 按本机事实改路径/版本） |
| 第三方插件 | `dsh-better-sidebar`（装在生产 profile 内，随 dsh 版本联动升级） |

以上是 **Chris 机器**的已验证基准（0.1.5-rc.2 → 0.1.7-rc.2，2026-09-25）。参考机（ShiLi）的
拓扑不同：生产是 launchd 服务 `io.shiliai.dsh-remote-mac`（:3280，`~/.local/dsh_home`），重启走
`scripts/prod-restart.sh`（launchd `kickstart -k` 单写者保证）+ `scripts/prod-restart-request.sh`
请求通道 + `scripts/wake-session.sh` 唤醒，见 AGENTS.md「Local environments」。在那台机器上做
dsh 本体升级时，把本 skill 的重启/唤醒步骤替换为上述现成脚本，其余阶段（Phase A 的对账、
staging 预装、插件兼容检查、冒烟）同样适用。

**Phase 0 — 动手前先核实本机事实**（机器间差异是事故之源）：生产端口/`DSH_HOME`/安装方式
（npm -g 还是 launchd 管理）、profile 里有哪些第三方插件、源码 clone 位置。逐条与脚本里的
常量对上，再进入 Phase A。

## Phase A — 生产会话内完成（全部落盘，本 turn 可正常结束）

1. **更新源码**：`cd ~/Project/deepseek-harness && git pull --ff-only origin master`；记录最新 release commit/tag（如 `dsh-v0.1.7-rc.2`）。
2. **对账 npm**：`npm view @deepseek-ai/dsh dist-tags`；确认目标版本已发布且与 git tag 同版本（`next` tag 通常领先 `latest`）。发布版与源码 tag 对应即可用 npm 包部署，无需本地构建。
3. **预装 staging**：`mkdir -p ~/Project/dsh-update-staging && cd 那里 && npm install @deepseek-ai/dsh@<ver>`；`node node_modules/@deepseek-ai/dsh/lib/bin.js --version` 自检。
4. **插件兼容检查**：遍历生产 profile 的第三方插件（`~/.dsh/profiles/web/node_modules/*/package.json`），比对每个插件 `peerDependencies` 里 `@deepseek-ai/*` 的范围是否包含新版本。不包含则查 npm 上该插件是否有匹配新 dsh 的版本，**插件与 dsh 必须一起升级**（本次 0.19.1→0.21.1）。
5. **调试 home + 冒烟**：新建 `~/.local/dsh-home-dev`（`cp -Rc` APFS 克隆生产 home，sessions 可不带），在其中 profile 里先升级插件；然后从 **staging 安装**启动调试实例验证新组合：
   ```
   python3 双重 fork + os.setsid() daemon 化（macOS 无 setsid 命令）：
   env DSH_HOME=~/.local/dsh-home-dev <staging>/lib/bin.js web --port 5280 --no-open
   日志 → ~/.local/dsh-home-dev/host.log（首行含 launch token）
   ```
   验证：端口监听、`curl /` 返回 401（鉴权墙正常）。
6. **写重启脚本**（以 `restart-prod-v2.sh` 为模板，按需改路径/版本）：见下方「脚本要点」。
7. **写持久报告**（如 `UPDATE-REPORT.md`）：基准事实、脚本行为、回滚资产。重启后由被唤醒的会话读取。

### 脚本要点（restart-prod-v2.sh 已内建，改模板时保持）

- `DSH_RESTART_GO=1` 武装开关：未武装一律 no-op。防误触发（挂起的批准、残留消息）。
- `DSH_RESTART_PREFLIGHT=1` 预检模式：逐项验证（state 目录、/opt 全局目录、生产 home/profile 可写、npm 可达、**可向生产进程发信号**），任何 FAIL 立即退出——**绝不先杀后装**。正式路径开头再硬校验一次 /opt 可写。
- 顺序：25s flush 缓冲 → 备份旧安装（`cp -Rc`，已存在则跳过）→ `kill -TERM` 生产进程并轮询等进程退出+端口释放（30s 不退升级 KILL，15s 仍不死则放弃，什么都不替换）→ `npm install -g @deepseek-ai/dsh@<ver>` → 生产 profile 插件升级 → 双重 fork detached 启动新宿主（`--port 3080 --no-open`，日志+launch token 落盘）→ 健康轮询（≤120s）→ **失败自动回滚**（rsync 备份回去 + 重启旧版）→ 从新日志抓 `token=` 铸 cookie（`curl -c jar "?token=..."`）→ `POST /api/session/prompt`（mode `queue`）唤醒发起会话。
- bash 3.2 坑：**`$( )` 内不能用 heredoc**（`X=$(cat <<EOF ... )` 解析错）；先 `cat > file <<'EOF'` 再读回。**函数必须定义在使用点之前**（逐行解释执行，前移定义）。

## Phase B — 交给调试 dsh 执行

1. **铸造调试实例 cookie**：从 `host.log` 取 launch token，`curl -s -c /tmp/debug-cookies.txt "http://127.0.0.1:5280/?token=<token>"`。
2. **建会话并切权限**（关键，两步都不能省）：
   - `POST /api/session/create`，body `{"type":"client-request","rpcId":"r1","method":"session/create","payload":{"args":{"request":{}}}}` → 得 `sessionId`。**0.1.7 起 session/prompt 不会懒建会话**（`session/not-found`）。
   - `POST /api/commands/execute`，`{"method":"commands/execute","payload":{"args":{"agentId":<sessionId>,"line":"/permission danger-full-access","submittedAttachments":[]}}}`。**API 新建会话默认 `workspace-write` + `approval=ask`**——上次事故的根因：它能杀掉生产却写不了 /opt。切换后 journal 应出现 `sandbox/mode: danger-full-access` + `approval/policy: never`。
   - RPC 参数包装不一致：`session/*` 用 `{args:{request:{...}}}`，`commands/execute` 用扁平 `{args:{...}}`。错了网关会报 `gateway/arguments-invalid` 并提示缺什么。
3. **触发 prompt**（`POST /api/session/prompt`，mode `queue`），指令必须包含：
   - 先 `DSH_RESTART_PREFLIGHT=1` 预检，要求输出 `PREFLIGHT OK`，任何 FAIL 停止并写报告；
   - 再 `DSH_RESTART_GO=1` 正式执行（bash timeout ≥ 480000ms）；
   - **「若已完成则只核验、勿重复执行」**——队列残留消息会让 agent 多开 turn 重复重启（本次实际发生，靠这条自救）；
   - 「不要调用 ask_user_question」——无人值守会话的问题没人能答，会卡死 turn；
   - 结束后把结果写进 `DEBUG-REPORT.md`（退出码、`dsh --version`、新监听 pid、唤醒响应、失败原因）；失败最多整体重试一次。
4. **队列机制**：`mode=queue` 的 prompt 在 agent **idle/abort 之后不会自动开新 turn**，需再发一条简短 kick prompt（它会和残留消息合并进同一 turn）。发出触发后**立即结束本 turn**（25s 缓冲 + LLM 延迟足够生产宿主 flush 当前 turn）。

## Phase C — 唤醒后核验（生产会话内）

1. `dsh --version` == 目标版本；
2. `lsof -iTCP:3080 -sTCP:LISTEN`：新 pid、PPID 1；`prod-web.log` 无 error/插件加载失败；
3. 能读到唤醒消息 = 会话恢复成功；
4. 读 `restart.log` + `DEBUG-REPORT.md`，向用户汇报；
5. 询问是否停调试实例（`kill -TERM <5280 pid>`；dev home 可留作下次冒烟用）；
6. 更新 `UPDATE-REPORT.md` 的最终结果段。

## 回滚

- 备份：`~/Project/dsh-backup-<oldver>/`（脚本自动创建）。
- 手动回滚：`rsync -a --delete ~/Project/dsh-backup-<oldver>/ /opt/homebrew/lib/node_modules/@deepseek-ai/dsh/`（插件同样降回），然后 detached 重启宿主。
- 脚本内建自动回滚：npm 失败或健康检查失败时触发。

## 版本升级副作用备忘

- 0.1.5→0.1.7：`~/.dsh/settings.yaml` 被自动迁移为 `settings.yaml.imported`，新配置进 `~/.dsh/storages/`——见到不要慌，宿主会自己完成。
- 浏览器 cookie 的 HMAC secret 持久在 `~/.dsh/.credentials.yaml`，跨重启有效；launch token 只在宿主启动日志里，每次重启都变。
