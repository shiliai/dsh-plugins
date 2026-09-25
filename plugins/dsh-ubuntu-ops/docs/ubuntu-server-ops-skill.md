# Ubuntu Server Ops Skill（体检 / 磁盘 / 升级）

本文是「Ubuntu 系统运维」模式的详版手册，全部内容提炼自本仓库真实 showboat 审计日志与
`hosts/*/memory/` 复盘笔记（出处见文末）。精简的运行时规则由 agent 预设
`ubuntu-ops` 的 persona 携带；本文件供按需查阅。硬性安全规则以 `AGENTS.md` 为准。

---

## 0. 只读巡检脚本（核心骨架）

`.claude/skills/server-maintenance/scripts/ssh_audit.sh`（144 行）是已多次实际运行验证的
只读巡检脚本（运行记录见 `logs/ops-server-maintenance-20260901.md`、
`logs/ops-gb10-2-20260917.md`）。结构即体检清单：

- **A. SYSTEM SNAPSHOT**：`hostname; whoami; . /etc/os-release && echo $PRETTY_NAME; uname -sr; uptime` / `nproc; free -h` / `ps -eo rss,comm --sort=-rss | head -12`
- **B. DISK & CLEANUP TRIAGE**：分优先级的清理候选（见 §4）
- **C. LOG/SECURITY REVIEW（近 7 天）**：auth 失败聚合、`journalctl --since -7d -p warning`、`systemctl --failed`、`journalctl -k | grep OOM/panic`、`journalctl --list-boots`
- **D. OTHER**：`sudo -n apt-get -s upgrade`（dry-run）、`last reboot`、`ss -ltn`、sudo 失败记录

关键设计：先探测 `sudo -n true`，无免密 sudo 时明确标注 "(no sudo) skipped/flagged" 而不是
失败；auth 扫描脚本通过 `ssh host bash -s` stdin 传入，规避引号地狱。

```bash
bash .claude/skills/server-maintenance/scripts/ssh_audit.sh <ssh-host-alias>
# 经 showboat exec 执行：
showboat exec "$LOG" bash "bash .claude/skills/server-maintenance/scripts/ssh_audit.sh <ssh-host-alias>"
```

---

## 1. 访问/登录异常检查

### 命令清单（日志中原样出现过）

```bash
# 登录历史（-i 显示 IP；n 控制条数）
last -i -n 40 | head -50
last -n 4 reboot 2>/dev/null | head -6        # 重启历史
who -b                                        # 上次开机时间
w; who                                        # 在线用户/IP

# 成功登录按 IP 聚合（覆盖所有 auth.log 轮转，含 .gz）
sudo -n sh -c 'zgrep -hE "Accepted (password|publickey)" /var/log/auth.log /var/log/auth.log.1 /var/log/auth.log.2.gz /var/log/auth.log.3.gz /var/log/auth.log.4.gz 2>/dev/null | awk "{for(i=1;i<=NF;i++) if(\$i==\"from\") print \$(i+1)}" | sort | uniq -c | sort -rn'

# 失败登录按 IP 聚合 top10（爆破面）
sudo -n sh -c 'zgrep -hE "Failed password|Invalid user" /var/log/auth.log* 2>/dev/null | grep -oE "from [0-9.]+" | sort | uniq -c | sort -rn | head -10'

# 追查特定可疑 IP 的全部记录
sudo -n sh -c 'zgrep -h "<可疑IP>" /var/log/auth.log* 2>/dev/null'

# 可疑账号核查：是否存在、家目录、authorized_keys、按键指纹、登录史、建号时间
getent passwd <user>
ls -la /home/<user>; cat /home/<user>/.ssh/authorized_keys
ssh-keygen -lf /home/<user>/.ssh/authorized_keys
last -i <user> | head -15
zgrep -h "useradd.*<user>" /var/log/auth.log*

# 长连接会话归属
w; ps -fp <pid>; pstree -sp <pid>

# sshd 加固基线
sudo -n sshd -T 2>/dev/null | grep -Ei "^passwordauthentication|^permitrootlogin|^pubkeyauthentication|^kbdinteractive"
grep -E "(bash|sh)$" /etc/passwd              # 有 shell 的账号清单
ss -tlnp | grep -E "<port>|sshd"

# fail2ban（如装了）
fail2ban-client status sshd 2>/dev/null
```

### 关注指标

- 成功登录 IP 分布与量级、失败登录 top IP（爆破强度）、非常规时段登录（对照用户自己的常用 IP 历史）
- 陌生 IP 使用的账号及其 `authorized_keys` 限制选项（`command=/usr/bin/false,restrict,permitopen=...`）
- `passwordauthentication` 是否开启（开启 = 月均数百次爆破尝试的风险面）、root 登录是否禁用
- 未知新账号 / 家目录创建时间 / `useradd` 溯源

### 真实案例模式（tokyo，2026-09-03）

发现 US IP `216.18.205.242` 有 4 次 Accepted 登录。追查结论：是受限账号 `ds-client`
（`command=/usr/bin/false,restrict,permitopen=127.0.0.1:18890`）的 VPS 中继链，建号时间与
首次登录对得上，判定为预期行为；同时把残余风险报给用户：`passwordauthentication=yes`
（月均 ~200 次失败，top IP 43.160.244.105 ×100）+ 与密钥所有者确认该 IP 为预期出口。

**模式：可疑 ≠ 直接处置。先溯源定性（只读），把风险项列给用户，再由用户决策。**

---

## 2. 应用/服务异常检查

### 命令清单

```bash
# systemd 服务
systemctl --failed --no-pager
systemctl status <svc> --no-pager 2>&1 | head -30
systemctl is-active <svc>; systemctl is-enabled <svc>
systemctl show <unit> -p ActiveEnterTimestamp
journalctl -u <svc> --since "16:50" --no-pager -o short-iso | grep -E "\[W\]|\[E\]|error|EOF|reset|timeout|closed|kick"
journalctl -u <svc> --no-pager -o short-iso -n 60
journalctl -u <svc> --since "..." --no-pager | grep -viE "token|secret|key" | tail -25   # 敏感词降噪
journalctl --user -u <user-svc> --since "2 min ago" --no-pager | tail -25                # user 级服务

# 按 unit 聚合错误数（找最吵的服务）
for u in $(systemctl list-unit-files --type=service --no-legend | awk '{print $1}' | head -150); do
  c=$(timeout 10 sudo journalctl --since "-7 days" -u "$u" -p err --no-pager 2>/dev/null | grep -c .)
  [ "$c" -gt 0 ] && echo "$c  $u"
done | sort -rn | head -15

# Docker 服务体检
docker ps -a --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"
docker inspect <ctr> --format "status={{.State.Status}} health={{.State.Health.Status}} restarts={{.RestartCount}} exit={{.State.ExitCode}} started={{.State.StartedAt}} memlimit={{.HostConfig.Memory}} oom={{.State.OOMKilled}}"
docker logs <ctr> --since 3m 2>&1 | grep -iE 'error|fatal|panic|exception' | grep -vi health | tail -20
docker logs <ctr> 2>&1 | grep -iE "error|panic|fatal|warn|oom|out of memory" | grep -viE "legacy_stdlog|cleanup|succeeded|stopping|stopped" | tail -40
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"
docker inspect -f "{{index .Config.Labels \"com.docker.compose.project.config_files\"}}" <ctr>   # 反查 compose 文件
docker exec <ctr> curl -sf -o /dev/null -w "http_code=%{http_code}\n" http://localhost:8080/health
curl -sS -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:<port>/<path>    # 401 视为"活着且有鉴权"

# 内存压力（OOM 排查）
sudo dmesg 2>/dev/null | grep -iE "out of memory|killed process" | tail -20
cat /proc/pressure/memory; vmstat 1 3; cat /proc/sys/vm/swappiness
ps aux --sort=-%mem | head -20
ps -eo stat,comm | awk '$1 ~ /D/'             # D 状态进程计数
cat /proc/loadavg
```

### 关注症状

`Restarting (1) 30 seconds ago`（重启循环）、`RestartCount` 增长、`OOMKilled=true`、
exit code 非 0、journal 里周期性 `Failed with result 'exit-code'`、D 状态进程堆积、
PSI pressure、逐进程 VmSwap、该监听的端口没监听。

### 真实案例

- **lisa sub2api OOM 死亡螺旋**（2026-09-08，复盘 `hosts/lisa-VPS_ops/memory/2026-09-10-sub2api-oom-memory-limit.md`）：
  1GB 小机上 sub2api 反复 OOM→重启→再 OOM，SSH banner 超时。处置链：`docker inspect`
  确认 exit/OOM → 用户手动 stop 容器打破循环 → 对照 GitHub issues 定位流式 `/responses`
  内存放大 → 升级到含缓解的版本 + compose `mem_limit` 护栏 → `docker stats --no-stream`
  多轮采样。结论：护栏保住主机，根治=加内存。
- **litellm mem_limit 不生效**（tokyo 2026-09-12）：compose 改 `mem_limit` 后 `up -d`
  未重建容器；`docker update --memory 1073741824 --memory-swap 2147483648 litellm`
  立即生效（`--memory-swap` 必须同时设，否则 swap 翻倍）。

---

## 3. 驱动/内核/硬件异常检查

### 命令清单

```bash
# GPU
nvidia-smi 2>&1 | head -40
nvidia-smi --query-gpu=name,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw --format=csv,noheader
nvidia-smi --query-gpu=name,driver_version,persistence_mode,power.limit --format=csv
sudo -n docker run --rm --gpus all ubuntu:24.04 nvidia-smi 2>&1 | tail -15   # 容器 GPU 通路验证
sudo journalctl -k --no-pager 2>/dev/null | grep -ai "NVRM: Xid" | tail -10

# 内核/硬件
sudo dmesg 2>/dev/null | grep -iE "out of memory|killed process" | tail -20
sudo journalctl -k --no-pager 2>/dev/null | grep -aiE "Out of memory|OOM|panic|Killed process" | tail -10
lspci 2>/dev/null | grep -iE "network|ethernet|vga|3d|display|audio"
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT
df -hT | grep -vE "tmpfs|devtmpfs|overlay"
sudo -n smartctl --scan 2>&1                  # smartctl 缺失 → 记为健康基线空白（红旗）
sudo -n dmidecode -t memory 2>/dev/null | grep -E "Locator:|Size:" | grep -Ev "No Module|Unknown"
pvs                                           # LVM 余量（只剩几百 MiB = 无法扩 LV 的硬约束）
ip -4 addr show | grep "inet "; ip -4 addr show wg0 2>/dev/null | grep inet

# 驱动栈与容器运行时（GPU 服务器开场勘察）
dpkg -l | grep -Ei 'nvidia-driver|nvidia-docker|container-toolkit' | awk '{print $2, $3}'
sudo -n docker info | grep -E 'Server Version|Storage Driver|Docker Root Dir|Cgroup Version|Runtimes|Default Runtime'
cat /etc/docker/daemon.json; command -v nvidia-ctk nvidia-container-cli

# 安全组件盘点（企业机变更前须知会安全团队）
ps aux | grep -iE 'falcon|crowdstrike|elkeid|zabbix|agent' | grep -v grep
```

### 关注症状与案例

- **GPU 两态记录**（svr066）：空闲 37°C / 满载 88°C、风扇 100%、显存 47462/49140MiB。
  模型未加载时温度无意义；定制卡显存 ≠ 标准值，记「非故障」。
- BIOS 落后多个版本（2.4.1 vs 2.17.0）→ 红旗，建议 `fwupdmgr` 路径。
- NTP 时钟漂移（快 8h）→ 备份 `/etc/ntp.conf`（`.backup-<ts>`）后补 NTP server。
- Ollama `OLLAMA_HOST=0.0.0.0:11434` 无鉴权内网全可达 → 红旗。
- CrowdStrike falcon-sensor（EDR）+ zabbix-agent 在跑 → 企业机变更前知会安全团队。

---

## 4. 磁盘空间检查与清理优先级（实证排序）

### 检查命令

```bash
df -h -x tmpfs -x devtmpfs -x efivarfs; df -i -x tmpfs -x devtmpfs -x efivarfs   # 空间+inode 双查
df -P -x tmpfs -x devtmpfs -x overlay | awk 'NR==1 || $5+0 >= 85 {print}'        # <15% 空闲告警
sudo -n du -x -d1 -h / 2>/dev/null | sort -rh | head -15                          # 根目录一层（-x 不跨 fs）
sudo -n du -x -d1 -h /var 2>/dev/null | sort -rh | head -10
du -xh -d1 /var/lib/docker 2>/dev/null | sort -rh | head -8
sudo -n find /var/log -type f -size +100M -exec ls -lh {} \;
timeout 30 find / -xdev -type f -size +100M -print 2>/dev/null | grep -vE "^/(proc|sys|run|snap)" \
  | while read -r f; do echo "$(du -h "$f" | cut -f1) $f"; done | sort -rh | head -20
docker system df; docker images -f dangling=true --format "{{.ID}} {{.Repository}}:{{.Tag}} {{.Size}}"
# 逐镜像判断是否被任何容器引用：
docker images --format "{{.ID}} {{.Repository}}:{{.Tag}} {{.Size}}" | while read id repo size; do
  if [ -z "$(docker ps -a --filter ancestor=$id -q)" ]; then echo "UNUSED $repo $size"; fi; done
docker volume ls -f dangling=true --format "{{.Name}}|{{.Labels}}" | head -20     # 清理前必查 compose 标签
docker ps -a --filter status=exited --format "{{.Names}} {{.Image}} {{.Status}}"
journalctl --disk-usage; grep -E "^#?SystemMaxUse" /etc/systemd/journald.conf
du -sh /var/cache/apt /var/lib/apt/lists 2>/dev/null
snap list --all; du -sh /var/lib/snapd                                            # disabled 旧 snap 版本
dpkg -l | grep -cE "^ii  linux-(image|headers|modules)"; uname -r                 # 旧内核 vs 运行内核
lsof -nP +L1 2>/dev/null | head                                                   # 已删除仍被进程持有
pgrep -af "wget|aria2|curl|huggingface|hf_hub|python.*download|\.partial"         # 活跃下载（删前必查）
```

### 清理优先级（Tier1 → Tier3，只报告不执行，执行需用户确认）

**Tier1 安全/可再生：**
1. docker 悬挂镜像 `docker image prune -f` → 未引用镜像 `docker image prune -a -f`（删除清单写入日志可回溯）→ 确认 UNUSED 的具名镜像逐个 `docker rmi`
2. journal：`journalctl --disk-usage` 评估 → `sudo journalctl --vacuum-size=500M --vacuum-time=7d` → 持久化：备份 `/etc/systemd/journald.conf` 后 `sed -i 's/^#SystemMaxUse=.*/SystemMaxUse=500M/'` + `sudo systemctl kill --kill-who=main --signal=SIGUSR2 systemd-journald`
3. `sudo apt-get clean`；pip/pnpm 缓存（`pnpm store prune`）

**Tier2 中风险：**

4. docker build cache：`docker builder prune --filter until=24h -f`
5. docker 悬空卷：先核对 Labels，**凡带 `com.docker.compose.project` 标签的具名卷不删**（postgres/redis data 等），再 `docker volume prune -f`
6. 应用日志：活跃写入的日志**先备份再 truncate 保 inode**（`cp access.log access.log.backup-<ts> && : > access.log`，随后 `lsof` 验证 + `nginx -t`）；已轮转的旧 log（如 `syslog.1`）备份后删除
7. 中断下载/构建残渣（`*.partial*`、`*resume*`、`completed-fragments`、`*.tar.zst`；删前确认无活跃下载进程）

**Tier3 逐项确认：**

8. 未在服务的大模型权重、HF/ollama 缓存 —— **绝不把 `~/.cache/huggingface/hub` 整体当安全目标**（正在被 vLLM 服务的模型就挂在 hub 缓存里）；先 `ps -eo pid,rss,args | grep -iE "vllm|llama"` + `docker inspect <c> -f "{{json .Mounts}}"` 核对，再逐目录确认
9. 旧内核 `apt-get autoremove --purge`；snap disabled 版本；工具版本目录（如 `~/.local/share/claude/versions/*`）；迁移包（tar 备份到 /tmp 验证条目数后再删）

**每步之后立即复验**：`df -h` + `docker system df` + 关键容器 `docker ps`；清理不得中断服务。

### 真实磁盘大户（参考量级）

- tokyo（59G 盘 84%→66%）：docker 镜像 11.94GB + build cache 6G、journal 2.9G、nginx access.log 313M、swap.img 8.1G
- lisa（9.6G 盘 97%）：apt archives、snap disabled 版本、14 个旧 linux-image 包
- gb10-2（1.8T 盘 99%→94%）：`~/.cache` 801G（HF hub 323G 等）、中断下载残渣 65G、tar.zst 17G → Tier2 回收 ~92G
- svr066：Ollama 模型库 145G + `/usr/share/ollama/.ollama` 33G 默认路径残留（旧库，删除需单独确认）

---

## 5. apt 升级流程（需用户确认后执行）

### 只读准备

```bash
apt list --upgradable 2>/dev/null | head -30
sudo -n apt-get -s upgrade 2>/dev/null | grep -E "upgraded|keep back|The following" | head -10
dpkg -l | grep linux-image; uname -r           # 旧内核盘点（autoremove 候选）
```

### 执行（remote tmux 长任务，实证模板）

```bash
tmux new-window -d -t agent-<host> -n phase1-apt "bash -lc 'exec > >(tee /tmp/phase1-apt.log) 2>&1; echo TASK-BEGIN; date -u +%FT%TZ; export DEBIAN_FRONTEND=noninteractive; for i in $(seq 1 40); do sudo -n fuser /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock >/dev/null 2>&1 && { echo WAIT-LOCK-HELD; sleep 15; } || break; done; sudo -n apt-get update && echo UPDATE-OK; sudo -n apt-get -y -o Dpkg::Options::=\"--force-confdef\" -o Dpkg::Options::=\"--force-confold\" install <目标包> && echo INSTALL-OK; sudo -n apt-get -y -o Dpkg::Options::=\"--force-confdef\" -o Dpkg::Options::=\"--force-confold\" full-upgrade && echo UPGRADE-OK; echo APT-DONE; date -u +%FT%TZ; PS1=\"\" exec bash --noprofile --norc'"
tmux set-option -t agent-<host>:phase1-apt remain-on-exit on
# 进度双通道：tmux capture-pane -p -S -30 -t agent-<host>:phase1-apt | tail -N；tail /tmp/phase1-apt.log | cat -v
```

规律（svr066 2026-09-18 实证）：

- 顺序固定：`apt-get update` → 显式 `install <目标包>` → `full-upgrade`；统一
  `DEBIAN_FRONTEND=noninteractive` + `-y` + `Dpkg::Options::=--force-confdef/--force-confold`（保留旧配置不弹交互）。
- **dpkg/apt 锁等待必做**：`unattended-upgrades`/`apt-daily` 占锁会让 `set -e` 秒退窗口
  （真实翻车点）；用 `fuser` 锁循环最多等 10 分钟。
- **tmux 长任务铁律**：不用 `set -e`（窗口静默退场）；`exec > >(tee /tmp/<task>.log) 2>&1`
  落盘 + `remain-on-exit on` + `&& echo <STAGE>-OK` 路标；交互提示用 `tmux send-keys ... Enter`。
- held back 内核：显式 `apt-get install <kernel-pkg>` 而非依赖 full-upgrade；**内核装好不自动
  reboot，重启单独请示用户**。
- 无免密 sudo：本地 tmux `ssh -t <host>` + `send-keys 'sudo -v' Enter` 交互缓存凭据
  （密码不进日志），再验证 `sudo -n true`。

### 升级后验证（只读）

```bash
uname -r; ls /boot/vmlinuz-* | tail -3; ls /var/run/reboot-required 2>/dev/null && cat /var/run/reboot-required
dpkg -l | grep linux-image                     # 旧内核 → autoremove 候选（需确认）
apt list --upgradable                          # 应为空或仅内核 held
systemctl --failed --no-pager                  # 0 个
docker ps                                       # 全容器 healthy
sudo journalctl -p err --since "-5 min" --no-pager | tail -20   # 无新错误
free -h; df -h
```

依赖修复模式：`dpkg -i` 失败 → `sudo -n apt-get install -f -y` 补依赖 → 验证。
数据库容器升级前先 `pg_dump` 备份（`docker exec <pg> pg_dump ... -Fc -f /tmp/x.dump` + `docker cp`）。

---

## 6. showboat/SSH 操作骨架

```bash
# ① 初始化（每主机每天一个日志）
LOG="logs/ops-${SSH_HOST}-$(date +%Y%m%d).md"
showboat init "$LOG" "SSH Operations on $SSH_HOST - $(date +%F)"
showboat note "$LOG" "Target: $SSH_USER@$SSH_HOST:$SSH_PORT in production. Task: <一句话目标>"
# ② 本地 observer tmux
tmux has-session -t "agent-${SSH_HOST}" 2>/dev/null || tmux new-session -d -s "agent-${SSH_HOST}"
# ③ 只读烟雾测试
ssh -T -o BatchMode=yes -o IdentitiesOnly=yes -o PasswordAuthentication=no -o StrictHostKeyChecking=yes -o ConnectTimeout=10 -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" 'hostname && whoami && uname -sr && id -u && date -u +%FT%TZ && uptime'
# ④ 每条命令（含本地命令）都走
showboat exec "$LOG" bash "<命令>"
# ⑤ 阶段意图/风险/决策用
showboat note "$LOG" "..."
# ⑥ 改配置前备份：cp <file> <file>.backup-$(date +%Y%m%d-%H%M%S)
# ⑦ typo 才允许 showboat pop；审计日志不跑 showboat verify
```

- **SSH_OPTS 基线**：`-T -o BatchMode=yes -o IdentitiesOnly=yes -o PasswordAuthentication=no
  -o StrictHostKeyChecking=yes -o ConnectTimeout=10`（不稳定链路加
  `ServerAliveInterval=5 -o ServerAliveCountMax=3`；临时 known_hosts 也保持
  `StrictHostKeyChecking=yes`，只是换 `UserKnownHostsFile=tmp/known_hosts.<test>`——
  **从不**用 `/dev/null` 或 `=no`）。
- **长任务 remote tmux**：会话 `agent-<host>`、每任务一个新窗口；窗口结尾固定
  `PS1='' exec bash --noprofile --norc`；捕获 `tmux capture-pane -p -S -30 -t agent-<host>:<win>`；中断 `tmux send-keys -t <t> C-c`。
- **远程跑本地脚本**：`ssh <host> bash -s <<'REMOTE' … REMOTE`（heredoc）或
  `scp` 到 `/tmp` 再 `bash /tmp/xxx.sh`。
- **复杂配置走 base64 通道**：`printf '%s' <base64> | ssh <host> 'sudo -n tee /etc/docker/daemon.json > /dev/null'`
  → 写后必须 `python3 -c "import json;json.load(open(...))"` 校验（svr066 引号转义破坏首写的教训）。
- **日志命名**：`ops-<host>-<YYYYMMDD>.md`；任务名写在 init 标题。
- **收尾归档**：在 `hosts/<host>_ops/memory/<YYYY-MM-DD>-<topic>.md` 写复盘
  （症状/时间线/根因/命令/修复/验证/教训）并更新该主机 README。

---

## 7. 坑与纪律（实证 13 条）

1. **引号地狱是最高频翻车点**：单行内嵌套 awk/sed/多引号 → 改用 heredoc / base64 通道 / 落脚本文件。
2. **长任务必须 remote tmux + 落盘日志双保险**：`tee` + `remain-on-exit on` + 路标 echo；不 `set -e`。
3. **所有扫描要有界**：`timeout 30 find …`、`timeout 45 journalctl …`、`curl -m 8/20/25`、`head -N`；大日志用 `--since` 窗口而非全量 grep。
4. **敏感信息纪律**：`.env` 只显示键名/形状（`sed "s/=.*/=<redacted>"`）、配置 `sed -E "s/(token|key|secret|password|id)\s*=.*/\1 = ***REDACTED**/Ig"`、journalctl 输出 `grep -viE "token|secret|key"`、密钥落远端 600 权限文件再引用。
5. **镜像源**：pip 清华源；docker `daemon.json` registry-mirrors + `"log-opts":{"max-size":"100m","max-file":"5"}`（防容器日志吃盘）+ `data-root` 装前定。
6. **Docker 网段避让**：bip `172.30.0.1/16` 避开宿主网段与 VPN 段（10/8、172.16/16）。
7. **compose 升级标准链**：`cp docker-compose.yml <backup>` → `sed -i "s|<old>|<new>|"` → `grep -n image:` 复核 → `docker compose pull`（pull 后 `df -h`）→ `up -d` → `inspect`（status/health/restarts）+ `logs --since 2m` + health 端点 → 稳定后 `docker rmi <old-tag>` + `df -h`。
8. **nginx**：改前 git 化 + `.backup-<ts>`；`nginx -t && nginx -s reload`；reload 后 curl 前后对照。
9. **数据库备份先于升级**：`pg_dump -Fc` → `docker cp` 拉回宿主验证大小。
10. **GPU**：起服务前后记录两态（空闲/满载显存、温度、功耗）；容器通路 `docker run --rm --gpus all ubuntu:24.04 nvidia-smi`；删模型权重前核对运行中服务的挂载源。
11. **磁盘规划**：NVMe 放"快"（系统/热模型/日志，journald 限 2G）、HDD 放"大"（docker data-root/HF 缓存/备份）；逐用途预算 + 告警线（≥15%/≥10%）；LVM 无余量 → "扩容只能加盘"先写明。
12. **sudo 状态探测先行**：`sudo -n true` → SUDO_NOPASSWD_OK / NEEDS_PASSWORD；无免密 sudo 巡检降级并标注 gap。
13. **结论归档**：任务结束写 `hosts/<host>_ops/memory/` 复盘 + 更新 README。

---

## 出处（主要）

`logs/ops-vps-tencent-tokyo-20260901/03/12/23/24.md`、`logs/ops-lisa-VPS-20260901/08/24.md`、
`logs/ops-james_ubuntu-20260918.md`、`logs/ops-server-maintenance-20260901.md`、
`logs/ops-svr066-20260918/21/24.md`、`logs/ops-dell-shili-7960-20260918/24.md`、
`logs/ops-gb10-2-20260917.md`、`logs/ops-feishu-APP-Pvjp-000-20260922.md`、
`logs/ops-HQ-310p-1-20260921.md`、`hosts/gb10-2_ops/memory/2026-09-17-disk-space-cleanup.md`、
`hosts/aas-chz-svr066_ops/memory/*.md`、`hosts/vps-tencent-tokyo_ops/memory/*.md`、
`hosts/lisa-VPS_ops/memory/*.md`、`.claude/skills/server-maintenance/scripts/ssh_audit.sh`、
`reference/ssh-ops-showboat-skill.md`、`reference/ubuntu-server-init-skill.md`。
