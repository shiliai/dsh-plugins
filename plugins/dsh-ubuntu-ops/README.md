# @dsh-plugins/dsh-ubuntu-ops

「Ubuntu 系统运维」agent 预设：一个**只读优先**的 Ubuntu 服务器体检与升级预设。它把
SSH_OPS 运维仓库里几十份真实 showboat 审计日志与主机复盘笔记沉淀的操作模式，固化成
DSH 会话可选的 agent persona——在 DSH Web 界面新建会话时选「Ubuntu 系统运维」即可使用。

这是本仓库第一个 **纯 patch 型 bundle**（preset-only，无 lib/ 构建、无依赖、不注册进
`scripts/verify-plugin-versions.mjs` 的代码插件清单），也可以作为「如何从运维历史提炼
agent 预设」的参考实现。

## 预设能力

| 能力 | 内容 |
|---|---|
| 访问异常检查 | `last -i`、失败/成功登录按 IP 聚合（auth.log* 含 gz）、可疑账号溯源（建号时间 / authorized_keys 指纹 / 登录史）、`sshd -T` 基线；原则：可疑≠处置，先溯源定性再报用户 |
| 应用异常检查 | `systemctl --failed`、按 unit 聚合 err 数、`journalctl -u <svc>` 重启循环过滤、docker inspect（RestartCount/OOMKilled/ExitCode）、健康端点探活、OOM 螺旋排查与 `docker update --memory` 护栏 |
| 驱动/内核异常检查 | `dmesg` / `journalctl -k` 过滤、`nvidia-smi` 两态基线（空闲/满载显存温度功耗）、Xid / I/O error / NIC reset、dmidecode / smartctl / pvs 盘点、EDR 与安全 agent 提醒 |
| 磁盘空间与清理建议 | df 空间+inode 双查、根目录逐层 du 下钻、docker UNUSED 镜像判定；清理候选按高→中→低三级给出（docker 镜像 / journal+SystemMaxUse 持久化 / 超大日志 → build cache / 悬空卷（compose 具名卷不删）/ apt 缓存与旧内核 → 大文件 / 下载残渣 / HF 缓存），每步后 `df -h` 复验 |
| 只读契约 | **用户确认前禁止任何修改**（禁改清单 + 永不执行清单写进 persona）；改前备份 `<file>.backup-<YYYYMMDD-HHMMSS>`；sudo 仅免密只读；全程 showboat 审计（`showboat init/note/exec`） |
| 系统升级 | 先 `apt-get -s upgrade` dry-run 概览 → 用户确认 → remote tmux 实证模板（`DEBIAN_FRONTEND=noninteractive` + `--force-confdef/confold` + dpkg 锁等待循环 + `tee` 落盘 + `remain-on-exit` + 阶段路标）→ 升级后验证（reboot-required / 旧内核 / 容器健康）；新内核不自动重启，重启单独请示 |

更完整的命令清单、真实案例与出处见
[`docs/ubuntu-server-ops-skill.md`](docs/ubuntu-server-ops-skill.md)。

## 安装

```sh
dsh plugin --profile web --config.dlx-cache-max-age=0 dlx \
  'github:shiliai/dsh-plugins#path:/plugins/dsh-ubuntu-ops'
```

安装后在 DSH Web 新建会话的预设列表选「**Ubuntu 系统运维**」（排在 standard / ptc /
minimal / cordis 之后）。预设变更只对新会话生效。

## 文件结构

```text
plugins/dsh-ubuntu-ops/
  cordis.patch.yml              # bundle patch：preset-ubuntu-ops 声明 + persona 正文
  persona.md                    # persona 的可维护源稿（改后重新注入 patch）
  docs/ubuntu-server-ops-skill.md  # 详版运维手册（命令清单 + 真实案例 + 出处）
  LICENSE
```

## 修改 persona

persona 正文以内联 YAML 块标量放在 `cordis.patch.yml`，源稿是 `persona.md`。改完源稿后
重新注入（内容行统一加 16 空格缩进，保持 YAML 块标量合法）：

```sh
python3 - <<'PY'
import io
patch, src = 'cordis.patch.yml', 'persona.md'
persona = io.open(src, encoding='utf-8').read().split('\n', 1)[1].lstrip('\n').rstrip() + '\n'
indented = '\n'.join((' ' * 16 + ln) if ln.strip() else '' for ln in persona.split('\n'))
text = io.open(patch, encoding='utf-8').read()
start = text.index('              prefix: |-\n')
end = text.index('              suffix: |-')
io.open(patch, 'w', encoding='utf-8').write(
    text[:start] + '              prefix: |-\n' + indented + text[end:])
PY
```

## 预设装载的插件清单

persona + `dsh-agent-instructions` + bash / fs / fs-search / jobs 工具 + skill 工具
（可加载使用方仓库的 `.claude/skills/`，例如 SSH_OPS 的 `server-maintenance` 巡检脚本）
+ ask-user / todo / goal + web 搜索 + compaction 组（长日志会话防膨胀）。
不装载子代理委派与 plan-mode 组——体检流程由 persona 的「只读证据 → 分级建议 → 确认 →
执行 → 验证 → 归档」契约驱动。

## 为什么不注册 verify-plugin-versions

`scripts/verify-plugin-versions.mjs` 的清单断言每个插件都有 `prepare: pnpm run build`
等代码插件属性。本插件是纯 patch bundle（无构建、无依赖），保持 patch-only 形态更符合
预设的定位；后续若新增第二个纯 patch 型 bundle，可考虑给版本校验脚本加一条
`kind: 'patch-only'` 分支。
