# @dsh-plugins/dsh-mac-net-ops

「MAC 系统网络运维」agent 预设：一个**只读优先**的 macOS 网络/路由/VPN/代理排障预设。它把
SSH_OPS 运维仓库里 2026-03 ~ 2026-09 的真实 showboat 审计日志与主机复盘沉淀下来的、**本机
反复发生过的网络路由类故障**固化成 DSH 会话可选的 agent persona——在 DSH Web 新建会话时选
「MAC 系统网络运维」，遇到断网 / VPN 拨不上 / 代理失效 / DNS 解析失败 / 换网后内网不通，
先跑只读体检、对号入座故障模式库，再给需确认的最小修复。

与 dsh-ubuntu-ops 同为**纯 patch 型 bundle**（preset-only，无 lib/ 构建、无依赖、不注册进
scripts/verify-plugin-versions.mjs 的代码插件清单）。

## 预设能力

| 能力 | 内容 |
|---|---|
| 一键只读体检 | mac-net-doctor.sh：主接口/全局默认路由（IFSCOPE 判据）、网关 ARP/ping、DNS（networksetup + scutil + dig）、utun 隧道、UniVPN 进程/日志/服务器可达性、VPN VIP 数据面（假连接检测）、代理端口与出口实测、残留路由启发式扫描；输出按区块分组，[ALERT] 即异常项 |
| 故障模式库 M1–M10 | 全部来自真实案例：M1 VPN 残留路由→拨不上；M2 DNS 被清空/路由挂死隧道；M3 V2RayU TUN × UniVPN 双隧道嵌套；M4 同子网双宿主丢全局默认路由；M5 代理 PAC 地址被 VPN 路由劫持；M6 证书错误/helper 进程死亡（EADDRNOTAVAIL 风暴）；M7 showboat 日志被二进制打坏；M8 TUN 全局接管劫持 direct 流量；M9 UniVPN 假连接（路由已装但数据面死）；M10 通用控制/AWDL 会话卡死 |
| 分诊决策树 | 症状 → 模式编号 30 秒定位，杜绝凭感觉重启 VPN 客户端 |
| 跨模式铁律 | 「路由正确」≠「通路健康」：netstat 有 default 行要 route get 验证；route add succeed 只代表控制面，要 ping 隧道 VIP 验证数据面 |
| 只读契约 | **用户确认前禁止任何修改**（route/networksetup/pkill/装卸 kext/重启全部需确认）；永不手删 utun、永不路由大扫除、永不绕过 host key 校验；sudo 无 TTY 时交用户终端或 tmux observer 会话执行 |
| 秘密卫生 | V2RayU sqlite 只 -readonly 查 routing 结构表、不碰 profile 表（节点凭据）；TUN 配置只 grep 路由策略字段；UniVPN 日志只 tail/grep 节选 |
| 审计与归档 | 全程 showboat（showboat init/note/exec）；修完复盘归档 hosts/<host>_ops/memory/，**新故障模式补回手册**让预设持续进化 |

更完整的命令清单、逐案例出处与验证清单见 docs/mac-net-ops-skill.md。

## 案例来源（SSH_OPS 仓库）

- reference/macmini_m4-vpn-proxy-conflict.md — M1/M5（UniVPN 劫持本机 IP、PAC 失效）
- hosts/macmini_m4_ops/memory/2026-06-21-network-outage.md — M4（丢全局默认路由，含修复与验证全记录）
- hosts/chriss_macbook_air_ops/memory/2026-07-16-univpn-wifi-routing.md — M3（双隧道嵌套）
- logs/ops-chriss-MacBook-Air-20260812.md / -20260613.md — M1/M2（残留路由、DNS 残留）
- logs/ops-chriss-MacBook-Air-20260909-vpndbg.md — M9（假连接：路由/控制面全"成功"但数据面死）
- logs/ops-chriss-MacBook-Air-20260917.md — M6（重拨失败 + helper 进程死亡）
- logs/ops-local-v2rayu-network-20260717.md — M8（TUN 劫持 direct 流量、微信媒体失败）
- hosts/macmini_m4_ops/memory/2026-09-12-universal-control.md — M10（通用控制卡死）

## 安装

```sh
dsh plugin --profile web --config.dlx-cache-max-age=0 dlx \
  'github:shiliai/dsh-plugins#path:/plugins/dsh-mac-net-ops'
```

安装后在 DSH Web 新建会话的预设列表选「**MAC 系统网络运维**」（排在 Ubuntu 系统运维之后）。
预设变更只对新会话生效。预设运行需要 SSH_OPS 工作区（体检脚本与详版手册在工作区
.claude/skills/mac-net-ops/ 下）。

## 文件结构

```text
plugins/dsh-mac-net-ops/
  cordis.patch.yml            # bundle patch：preset-mac-net-ops 声明 + persona 正文
  persona.md                  # persona 的可维护源稿（改后重新注入 patch）
  docs/mac-net-ops-skill.md   # 详版手册（M1–M10 模式库 + 命令速查 + 案例出处）
  LICENSE
```

## 修改 persona

persona 正文以内联 YAML 块标量放在 cordis.patch.yml，源稿是 persona.md。改完源稿后重新注入
（内容行统一加 16 空格缩进，保持 YAML 块标量合法）：

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

与 dsh-ubuntu-ops 相同：persona + dsh-agent-instructions + bash / fs / fs-search / jobs 工具
+ skill 工具（可加载 SSH_OPS 工作区的 .claude/skills/mac-net-ops 体检脚本与手册）
+ ask-user / todo / goal + web 搜索 + compaction 组（大日志会话防膨胀）。不装载子代理委派
与 plan-mode 组——排障流程由 persona 的「只读证据 → 分级建议 → 确认 → 执行 → 验证 → 归档」
契约驱动。

## 为什么不注册 verify-plugin-versions

同 dsh-ubuntu-ops：scripts/verify-plugin-versions.mjs 的清单断言每个插件都有
prepare: pnpm run build 等代码插件属性，本插件是纯 patch bundle（无构建、无依赖），
保持 patch-only 形态更符合预设定位。
