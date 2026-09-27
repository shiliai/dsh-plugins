# MAC 系统网络运维 — 详版手册

> 本手册是 `@dsh-plugins/dsh-mac-net-ops`（`preset-mac-net-ops`）的详版文档，内容提炼自
> SSH_OPS 运维仓库 2026-03 ~ 2026-09 的真实 showboat 审计日志与主机复盘（出处见文末索引）。
> 预设的 persona 内联在 `cordis.patch.yml`（源稿 `persona.md`），运行时指向 SSH_OPS 工作区内的
> `.claude/skills/mac-net-ops/SKILL.md` 与 `scripts/mac-net-doctor.sh`。


# MAC 系统网络运维(mac-net-ops)

> 预设来源:本仓 `logs/` 下 2026-03 ~ 2026-09 的真实故障审计日志 + `hosts/*_ops/memory/` 复盘 +
> `reference/macmini_m4-vpn-proxy-conflict.md`。所有「历史高发」结论都有对应案例文件佐证。

## 0. 标准动作顺序

1. **先跑只读体检**,不要凭症状猜:
   ```bash
   bash .claude/skills/mac-net-ops/scripts/mac-net-doctor.sh [vpn-hostname] [vpn-port]
   # 常用: bash .claude/skills/mac-net-ops/scripts/mac-net-doctor.sh fulander.dscloud.biz 8888
   ```
   输出里每个 `[ALERT]` 都对应下方故障模式库中的一条;把体检结果与模式库对号入座。
2. 若在 SSH_OPS 仓内,先建 showboat 日志再跑诊断(见 §6),所有命令经 `showboat exec`。
3. 向用户给出「根因假设 + 最小修复方案」,**等确认后**才执行任何改动(见 §5 安全规则)。
4. 修完用最小只读检查验证(§7 验证清单),并按 §8 归档。

## 1. 本机网络档案(诊断前先对齐,变动时以实测为准)

两台经常出问题的 Mac,都跑 V2RayU(代理)+ UniVPN(公司私网隧道)双层网络:

| 项 | chriss-MacBook-Air(控制端) | macmini_m4(Chriss-Mac-mini.local) |
|---|---|---|
| 角色 | 本地 SSH 运维控制台 / 日常开发机 | 常驻运维 agent host(可被 SSH) |
| 接口 | en0(Wi-Fi/有线随环境变化) | en0 有线(主) + en1 Wi-Fi(Handoff),**同子网双宿主** |
| 历史网段/网关 | 192.168.88.1 → 192.168.1.1 → 192.168.195.128 → 192.168.88.2(**多次换网**) | 192.168.88.0/24,网关 192.168.88.1 |
| UniVPN | fulander.dscloud.biz:8888(私网 10.10.1.x;VPN DNS 223.5.5.5/223.6.6.6 走隧道) | 同上,历史上会往路由表加私网/DNS/出口 host 路由 |
| V2RayU | 5.x(xray-core;本地端口常见 10808/10809/11111,PAC 11085;旧默认 1080/1087) | 5.x( 曾用 1080/1087/PAC 11085) |
| 特殊性 | 换网频繁 → 残留路由是常态 | 同子网双宿主 → 丢全局默认路由是高危点 |

> 因为网段换过多次,**"指向旧网关的静态 host 路由"是本机第一高发故障**。任何「拨不上/连不上」,
> 第一步查路由,而不是重启 VPN 客户端。

## 2. 30 秒分诊决策树

```
症状是什么?
│
├─ 完全断网(公网不通,内网/网关通)
│    └→ 查"全局默认路由"是否丢失(§3 模式 M4)  ← netstat default 行含 IFSCOPE、route get 8.8.8.8 "not in table"
│
├─ VPN 拨不上(UI 报 "VPN server may not be reachable")
│    ├→ route -n get <VPN服务器IP> 指向不可达旧网关 → 残留路由(M1)
│    ├→ dig 解析失败 / DNS 路由指向已消失的隧道 → DNS 残留(M2)
│    ├→ 服务器本身不可达(ping/nc 都失败且路由正常) → 外部问题(服务器掉线/运营商)
│    └→ UI 报设备证书错误 AUTH_MSGCODE_LOGIN_DEVICECERT_ERROR → 证书/账号问题,找管理员(M6)
│
├─ VPN 已连,但内网(10.10.1.x / 192.168.88.x)时通时断
│    ├→ 双隧道嵌套:UniVPN 外层被 V2RayU TUN 吞掉(M3)  ← 查 VPN 服务器/公网网关 IP 的路由走 utun 还是 en0
│    └→ ping 隧道 VIP(10.10.1.x)也不通、但 VPN 日志 route add 全 succeed
│         → "假连接":数据面未打通,重拨/重启客户端,别改路由(M9)
│
├─ 换 Wi-Fi 后 VPN 拨不上、清完路由还是连不上
│    └→ UI 日志 EADDRNOTAVAIL 风暴 + "UI can't connect RPC" = helper 进程已死(M6)→ 重启客户端
│
├─ V2RayU TUN 开着,某些应用(如微信媒体)大流量收发失败、连 LAN 直连都超时
│    └→ TUN 全局接管(分段大网段包住 0/0)劫持了 direct 流量(M8)  ← route get <目标> 命中 utun?
│
├─ 代理"失效",浏览器打不开外网,V2RayU 进程还在
│    ├→ PAC 里的代理地址是 LAN IP,被 VPN 路由劫持(M5)  ← route -n get <LAN_IP> 走 utun?
│    └→ 本地端口没监听/端口变了(V2rayU 5.x 换端口) → 体检脚本 §6 直接暴露
│
├─ DNS 解析失败但 ping IP 通
│    ├→ DNS 服务器列表被 VPN 清空/未恢复(M2)
│    └→ 指向公共 DNS(223.5.5.5 等)的路由还挂在已消失的隧道接口上(M2)
│
└─ 网速慢/时通时断(非完全断)
     └→ 双隧道嵌套(M3)或换 Wi-Fi 后隧道重连高延迟;查 lsof 看隧道外层 socket 绑在哪个接口
```

## 3. 故障模式库(历史真实案例)

### M1 · VPN 残留路由 → 拨不上(最高发)
- **案例**: 2026-08-12 MacBook Air(`logs/ops-chriss-MacBook-Air-20260812.md`)、2026-06-13(`logs/ops-chriss-MacBook-Air-20260613.md`)
- **症状**: UniVPN 反复报 "Failed to establish the VPN connection. The VPN server may not be reachable."
- **根因**: 上一个网络/上一段 VPN 会话留下的静态路由没被清:
  - VPN 服务器 IP(如 58.37.133.37/32)指向**旧网关**(192.168.88.2/192.168.1.1,当时不可达)
  - VPN 网关/客户端地址(10.10.1.x/32)指向 lo0
  - 公共 DNS(223.5.5.5/223.6.6.6/32)指向已消失的隧道
- **诊断**:
  ```bash
  dig +short fulander.dscloud.biz          # 先解析出当前 VPN 服务器 IP
  route -n get <VPN_IP>                    # gateway 是旧网关且 ping 不通 → 命中
  ping -c 2 -W 2 <旧网关IP>                # 100% 丢包 = 网关不可达
  nc -vz -G 3 <VPN_IP> 8888                # "Can't assign requested address" 也是路由异常信号
  ```
- **修复(需确认)**:
  ```bash
  sudo route delete -host <VPN_IP>
  sudo route delete -host <残留的隧道/网关地址>
  ```
- **坑**: agent 会话里 `sudo` 没有 TTY 会失败("a terminal is required")——要么让用户自己在终端跑,
  要么走本地 tmux 会话执行。改完用 `route -n get <VPN_IP>` + `nc` 验证路由已回到默认网关。

### M2 · DNS 被清空 / DNS 路由挂死隧道
- **案例**: 2026-08-12 / 2026-06-13 MacBook Air
- **症状**: `dig` 超时,`ping <IP>` 却正常;UniVPN 断开后 DNS 一直坏。
- **根因**: UniVPN 会话中断时把 `networksetup -setdnsservers` 改成隧道 DNS(或清空),留下
  223.5.5.5/223.6.6.6 → 10.10.1.x 的路由;隧道没了路由还挂着。
- **诊断**: `networksetup -getdnsservers "Wi-Fi"`; `scutil --dns` 前 12 行;
  `netstat -rn -f inet | grep -E '223\.5\.5\.5|223\.6\.6\.6'`
- **修复(需确认)**:
  ```bash
  sudo route delete -net 223.5.5.5 -netmask 255.255.255.255
  sudo route delete -net 223.6.6.6 -netmask 255.255.255.255
  sudo networksetup -setdnsservers "Wi-Fi" empty   # 恢复 DHCP 下发;或按需设 223.5.5.5 223.6.6.6
  ```

### M3 · V2RayU TUN × UniVPN 双隧道嵌套(换 Wi-Fi 后内网时通时断)
- **案例**: 2026-07-16 MacBook Air(`hosts/chriss_macbook_air_ops/memory/2026-07-16-univpn-wifi-routing.md`)
- **症状**: 切 Wi-Fi 后 VPN 私网主机不可达/高延迟(~350ms),UniVPN 面板上仍"已连接";
  UniVPN 日志见 SSL 网关 send failed 后撤掉私网路由。
- **根因**: V2RayU/sing-box TUN 是 `auto_route + strict_route` 且**没有排除 UniVPN 网关地址**,
  UniVPN 到公网网关的外层连接被塞进 V2RayU 隧道,外层一断,私网路由被撤。
- **诊断**:
  ```bash
  route -n get <VPN公网网关IP>        # interface 是 utun(V2RayU) 而不是 en0 → 命中
  route -n get <VPN服务器IP>          # 外层路径同样检查
  lsof -nP -a -p <UniVPNCS_PID> -i    # VPN 外层 socket 绑在哪个地址/接口
  ```
- **修复(需确认,二选一)**:
  - 持久修:给 V2RayU TUN 配置加 **route_exclude_address <VPN网关/服务器 IP>**(或按进程放行 UniVPN);
  - 临时修:换网后按顺序重连——暂停 V2RayU TUN → UniVPN 重连并确认外层走 en0 → 再开 V2RayU。
- **不要**: 手动大范围删路由、手删 utun 接口(macOS/Network Extension 会自己管理,手删反而双隧道全断)。
- **验证**: 外层走 en0、私网走 VPN 接口、切一次 Wi-Fi 不再断;别只看"私网路由存在"——
  **私网路由正确 ≠ 外层传输健康**(本案例核心教训)。

### M4 · 同子网双宿主丢全局默认路由(公网断、内网通)
- **案例**: 2026-06-21 macmini_m4(`hosts/macmini_m4_ops/memory/2026-06-21-network-outage.md`)
- **症状**: ping 网关 2ms 通,ping 8.8.8.8 → `No route to host`,DNS 也挂;用户观感"像重启了"。
- **根因**: en0 有线 + en1 Wi-Fi 同 /24;链路抖动 + GUI 会话强制注销重登 + Jetsam 内存压力三连发,
  configd 重建路由时只留下**绑 en1 的 scoped 默认路由**,全局默认路由没了。
- **关键判据**(netstat 有 default 行 ≠ 全局可用):
  ```bash
  route -n get -inet 8.8.8.8          # "not in table" = 无全局默认路由
  netstat -rn -f inet | grep default  # flags 含 I(IFSCOPE) 的只是 scoped 局部默认
  echo 'show State:/Network/Global/IPv4' | scutil   # 看 PrimaryInterface 认了谁
  sysctl -n kern.boottime; last reboot; pmset -g log | grep -iE 'sleep|wake'
  # ↑ 排除"真的重启/睡眠"——GUI 注销重登(loginwindow/WindowServer 进程时间戳)不是重启
  ```
- **修复(需确认)**:
  ```bash
  sudo route -n add -inet default <网关IP>                                    # 立即恢复(创可贴)
  sudo networksetup -setmanual "Ethernet" <本机IP> <掩码> <网关IP>            # 耐久:让 configd 托管
  ```
- **长期**: 有线+Wi-Fi 可同时开(Handoff 需要),靠**网络服务顺序**(以太网在上)防复发;
  configd 会覆盖手工 route 改动,手工 `route add` 只是临时。

### M5 · 代理 PAC 地址被 VPN 路由劫持(V2RayU 在跑但"翻不出去")
- **案例**: 2026-06-14 macmini_m4(`reference/macmini_m4-vpn-proxy-conflict.md`)
- **症状**: UniVPN 一连,V2RayU 还在运行,但 Google 等全打不开(浏览器回退 DIRECT 被 GFW 挡)。
- **根因**: PAC 文件(`~/.v2rayu/proxy.js`)里代理地址写的是**本机 LAN IP**(192.168.88.140:1080);
  UniVPN 把本机自己的 IP 也塞进隧道路由(`192.168.88.140/32 → 10.10.1.x → utunX`),
  浏览器连"本机"代理的流量被路由进 VPN 隧道 → 超时。
- **诊断**:
  ```bash
  route -n get <本机LAN_IP>            # 走 utun = 命中(本机 IP 被劫持进 VPN)
  head -5 ~/.v2rayu/proxy.js           # 代理地址是 LAN IP 还是 127.0.0.1
  curl -x socks5://127.0.0.1:1080 https://www.google.com   # 环回访问应 OK
  ```
- **修复(需确认)**:
  ```bash
  # 快速: PAC 地址改成环回(注意 V2RayU 重新生成 PAC 会还原)
  sed -i '' 's/<LAN_IP>/127.0.0.1/g' ~/.v2rayu/proxy.js
  # 耐久: 绕开 PAC,直接设系统 HTTP(S) 代理到环回
  networksetup -setautoproxystate "Wi-Fi" off
  networksetup -setwebproxy "Wi-Fi" 127.0.0.1 <HTTP端口>
  networksetup -setsecurewebproxy "Wi-Fi" 127.0.0.1 <HTTP端口>
  networksetup -setwebproxystate "Wi-Fi" on && networksetup -setsecurewebproxystate "Wi-Fi" on
  ```
- **通用教训**: **代理地址永远写 127.0.0.1,不要写 LAN IP**;V2RayU 5.x 本地端口常见 10808/10809/11111,
  以体检脚本实测监听端口为准。

### M6 · UniVPN 设备证书 / 会话异常(路由正常仍拨不上)
- **案例**: 2026-09-23(`~/.univpn/log/UniVPN_UniVPNUI_*.log`: `AUTH_MSGCODE_LOGIN_DEVICECERT_ERROR`)、
  2026-09-24(Cnem "send packet to gateway failed" 后正常撤路由)
- **判据**: 路由、网关、服务器可达性全部正常,UI 反复报证书/认证错误码。
- **处置**: 不要再改路由。检查 VPN 进程状态、重登账号/更新设备证书,必要时问管理员;
  进程卡死(UI 显示断开但进程残留、重试同错)可提议 `pkill -f UniVPN`(需确认)后重启客户端。
- **helper 进程已死的特征**(2026-09-17 案例,`logs/ops-chriss-MacBook-Air-20260917.md`):
  - UI 日志持续 `Fail to connect socket,-1,49 (EADDRNOTAVAIL)` 风暴 → `UI and RPC connection failed!`
  - `ps -p <UniVPN_PID> -p <UniVPNCS_PID>` 为空但 UI 窗口还在
  - 判定 helper 死后**停止修路由**,直接完全退出并重启 UniVPN 重新登录;
    清残留路由(旧 VIP → lo0)只做一次,保留服务器 /32 静态路由。
  - 日志里 `reconnect success` 之后紧跟 `CNEM ERROR (CHIV UDPS send packet to gateway failed)`
    才是真相,别被 "success" 骗了。
  - kext 是否缺失要和"此前是否可用"对照着判,不要看见 NOT LOADED 就下结论。

### M7 · 审计日志本体损坏(showboat 排障的次生灾害)
- **案例**: 2026-07-16 `logs/ops-local-network-20260716.md` 被一次二进制搜索输出的超长行/二进制字节
  打坏,showboat 读不了,只能另开 recovery 日志窄修复。
- **规矩**:
  - 对二进制文件(`.app` 内的二进制、图片)只用 `rg -a`/`strings` + `head` 截断,不要整段倒进日志;
  - `sed -n 'a,bp' | cut` 处理可能含非 UTF-8 的日志时加 `LC_ALL=C`;
  - 文件被识别为 binary(含 NUL)时先用 `tr -d '\000' < file` 清洗再读;
  - showboat 日志损坏时:另开 recovery 日志记录修复过程,**不要**删除原日志里的正当诊断记录。

### M8 · V2RayU TUN 全局接管劫持 direct 流量(应用大流量/UDP 失败,连 LAN 都超时)
- **案例**: 2026-07-17 MacBook Air(`logs/ops-local-v2rayu-network-20260717.md`)
- **症状**: V2RayU TUN 开启时微信图片/视频收发失败;sing-box core 日志大量
  `dial tcp 192.168.88.9:6690 ... i/o timeout`(连 **LAN 直连出站**都超时)。
- **根因**: TUN 用**分段大网段**(1, 2/7, 8/5…)包住 0/0 而不是改 default——所以
  `route -n get default` 看着正常,但具体目标全命中 utun(gateway 10.0.0.1);
  目标不在 geoip "大陆"分类内就走代理出站,大流量/UDP 场景失败;路由预设里还有
  优先级更高的 UDP/443 reject 规则会放大故障。
- **诊断**:
  ```bash
  route -n get 1.1.1.1; route -n get 192.168.88.1   # 都命中 utun = TUN 全局接管
  route -n get default                              # 物理默认路由仍在(对照,别被骗)
  sqlite3 -readonly ~/.V2rayU/.V2rayU.db 'SELECT name, remark, direct FROM routing'  # 路由预设(只读+不碰凭据表)
  jq '.route.rules' ~/.V2rayU/tun.json              # 生成的 TUN 路由规则(注意截断/脱敏)
  ```
- **修复(需确认)**: 给 TUN 加 `route_exclude_address`(地址排除走直连)或**进程级直连规则**
  (已验证最稳的兜底——geoip 绕过对分类外目标无效);微信等媒体应用目标加直连。
  已有上游改进分支:`codex/tun-route-exclusions`、`codex/tun-process-routing`(提交 3a986cc)。
- **验证**: `route -n get <应用目标>` 不再命中 utun;core 日志目标流量走 direct 出站;应用实测收发成功。

### M9 · UniVPN "假连接":路由已装、控制通道通,数据面死
- **案例**: 2026-09-09 MacBook Air(`logs/ops-chriss-MacBook-Air-20260909-vpndbg.md`)
- **症状**: UniVPN 显示已连接,`netstat -rn` 里私网路由齐全,但访问 192.168.88.0/24 全不通。
- **根因**: **L3 数据面未打通**——TCP 8888 控制通道可达、CNEM 路由安装全部 succeed,
  但 vnic 虚拟网卡不转发包(隧道假连接)。路由表完全正常,问题在隧道数据面。
- **判据**:
  ```bash
  ping -c 2 -W 2 <隧道VIP>          # 10.10.1.x,100% 丢包 = 数据面死(决定性证据)
  ping -c 2 -W 2 <私网目标>          # 同样不通
  nc -vz <VPN服务器> 8888            # 控制通道 succeeded(对照组:别被它迷惑)
  ```
- **处置**: **不要改本机路由**。重拨 / 完全重启 UniVPN 客户端,反复复现再查服务端。
- **教训**: "路由正确 + 控制通道通 ≠ 数据面通";VPN 日志的 route add succeed 只代表控制面。

### M10 · 通用控制(Universal Control)/ AWDL 会话卡死(唤醒后跨机失效)
- **案例**: 2026-09-12(`hosts/macmini_m4_ops/memory/2026-09-12-universal-control.md`)
- **症状**: MacBook Air 睡眠唤醒后鼠标/键盘无法跨到 macmini;SSH、普通网络都正常。
- **诊断**:
  ```bash
  ps aux | grep UniversalControl                       # 两台进程都在?
  dns-sd -B _companion-link._tcp                       # 对方 _companion-link 可见?(_ssh 可见=mDNS 没坏)
  defaults read com.apple.UniversalControl 2>/dev/null  # 排除配置问题(域不存在=未配置过)
  log stream --predicate 'process == "UniversalControl"' --debug    # 看 P2P/AWDL 关闭码(如 -6723)
  ```
- **根因**: 控制器侧 UniversalControl 会话睡眠唤醒后卡死(AWDL 状态性故障),网络/账号/配置全对。
- **修复(需确认)**: 两侧 `killall -9 UniversalControl`——**SIGTERM 会被屏蔽**,必须 -9;
  launchd 会自动拉起新进程。
- **验证**: 新进程日志互为 connected devices;用户实测鼠标跨越成功(验证要到用户操作层)。

## 4. 诊断命令速查(全部只读)

```bash
# 路由层
netstat -rn -f inet                                   # 全表;default 行看 flags 有无 I(IFSCOPE)
route -n get -inet 8.8.8.8                            # 全局默认路由存在性(GLOBAL flag / not in table)
route -n get <目标IP>                                 # 任何目标的第一跳走向
netstat -rn -f inet | awk '$1 ~ //32$/'              # 静态 host 路由(残留排查候选)
netstat -rn -f inet | awk '$2=="127.0.0.1" && $1 !~ /^(127|Destination)/'   # 挂 lo0 的可疑路由

# 接口与链路层
ifconfig -l; ifconfig <IF>                            # utun0-11 常态存在,多个 utun ≠ 故障
echo 'show State:/Network/Global/IPv4' | scutil       # PrimaryInterface / Router
ping -c 2 -W 2 <网关>; arp -n <网关>                   # 网关通不通、ARP 落在哪个接口

# DNS
networksetup -getdnsservers "Wi-Fi"; scutil --dns | head -12
dig +short +time=2 +tries=1 <域名>

# VPN
dig +short fulander.dscloud.biz; route -n get <VPN_IP>; nc -vz -G 3 <VPN_IP> 8888
ping -c 2 -W 2 <隧道VIP>           # 数据面验证(M9):路由再对,VIP ping 不通就是假连接
ls -t ~/.univpn/log/* | head; grep -E 'ERROR|Failed|not be reachable|route add' <最新CS日志> | tail -12
sqlite3 -readonly ~/.V2rayU/.V2rayU.db 'SELECT name, remark, direct FROM routing'   # V2RayU 路由预设(勿碰 profile 表)

# 代理
lsof -nP -iTCP -sTCP:LISTEN | grep -Ei 'v2ray|xray|sing-box'
curl -s -o /dev/null -w '%{http_code}' -m 6 -x socks5://127.0.0.1:<PORT> https://www.google.com
networksetup -getwebproxy "Wi-Fi"; networksetup -getautoproxyurl "Wi-Fi"

# 排除"重启/睡眠"假象
sysctl -n kern.boottime; last reboot; last | head
pmset -g log | grep -iE 'sleep|wake'
ps -axo pid,lstart,comm | grep -iE 'loginwindow|WindowServer'
```

## 5. 修复安全规则(来自 AGENTS.md,本预设必须遵守)

- **只读先行**: 体检/诊断全部只读;任何 `route delete/add`、`networksetup` 改写、
  杀 VPN/代理进程、改 DNS,先向用户给方案并**等明确确认**。
- **最小改动**: 只删确认是残留的那几条 host 路由;不要 `iptables -F` 式的大扫除,不要手删 utun。
- **sudo 无 TTY**: agent 会话里 `sudo` 会失败,把命令交给用户在本地终端执行(输出可回贴进日志),
  或用本地 tmux observer 会话(`agent-<hostname>`)执行。
- **configd 会翻盘**: 手工 `route add` 可能被 configd 按网络服务顺序覆盖;耐久修要用
  `networksetup` 重新下发配置或调整服务顺序。
- **不倒敏感配置**: V2RayU 的 sqlite(`~/.v2rayu/.V2rayU.db` 的 profile 表)与 TUN 配置含节点凭据,
  只查 routing/表名等结构性字段或只 grep 路由策略字段,不整库/整文件输出。
- **嵌套隧道顺序**: 双隧道都活着时,不要贸然重连/杀其一;先看 §M3 的连接顺序。

## 6. showboat 留痕规范

```bash
LOG="logs/ops-$(hostname -s)-$(date +%Y%m%d).md"
showboat init "$LOG" "Local network diagnostics on $(hostname -s) - $(date +%F)"
showboat note "$LOG" "Issue: <症状一句话>. Target: localhost."
showboat exec "$LOG" bash "<每一条诊断/修复命令>"
```

- 体检脚本的完整输出也要 `showboat exec` 包一层(或逐段粘贴)。
- 失败命令保留;仅明显笔误或泄密用 `showboat pop`。
- **不要**对含改动命令的日志跑 `showboat verify`。
- 日志防损坏: 二进制内容不直接进日志(M7)。

## 7. 修复后验证清单(最小只读检查)

- [ ] `route -n get <出问题目标>` → 走向正确接口/网关,无残留
- [ ] `netstat -rn -f inet | grep default` → 全局默认路由在位(flags 无 IFSCOPE-only)
- [ ] `ping <网关>` + `ping 8.8.8.8`(或出问题目标)0% 丢包
- [ ] `dig +short <域名>` 解析恢复; `networksetup -getdnsservers` 状态符合预期
- [ ] 代理: `curl -x socks5://127.0.0.1:<PORT>` 返回 200;PAC/系统代理地址是 127.0.0.1
- [ ] VPN: `nc -vz <VPN_IP> 8888` 通;UniVPN 日志无新错误
- [ ] 复现原触发条件(如切一次 Wi-Fi)不再复发(按案例要求)

## 8. 事后归档(AGENTS.md Debug Archive Convention)

1. 修复验证通过后,在 `hosts/<host>_ops/memory/` 写 `YYYY-MM-DD-<topic>.md` 复盘:
   症状 / 时间线 / 根因 / 诊断命令 / 修复 / 验证 / 教训。
2. 若是新故障模式(本文件 §3 没有的),**把新模式补进本 SKILL.md** 和 `hosts/<host>_ops/README.md` 活动列表。
3. 原始 showboat 日志留在 `logs/`,归档只放脱敏摘要(去掉凭据/密钥路径/内部 ID)。

## 9. 参考文件索引(本预设的事实依据)

- `reference/macmini_m4-vpn-proxy-conflict.md` — M1/M5 原始案例
- `hosts/macmini_m4_ops/memory/2026-06-21-network-outage.md` — M4 原始案例(含修复与验证全记录)
- `hosts/chriss_macbook_air_ops/memory/2026-07-16-univpn-wifi-routing.md` — M3 原始案例
- `logs/ops-chriss-MacBook-Air-20260812.md` / `-20260613.md` — M1/M2 审计日志
- `logs/ops-local-network-20260716.md` / `ops-local-v2rayu-network-20260717.md` — M3/M7 审计日志
- `logs/ops-chriss-MacBook-Air-20260909-vpndbg.md` — M9 假连接案例
- `logs/ops-chriss-MacBook-Air-20260917.md` — M6 helper 死亡 / 重拨失败案例
- `logs/ops-local-v2rayu-network-20260717.md` — M8 TUN 劫持 direct 流量案例
- `logs/ops-192.168.88.140-20260621.md` / `ops-macmini_m4-20260912.md` — 事件原始审计日志
- `hosts/macmini_m4_ops/memory/2026-09-12-universal-control.md` — M10 案例
- `.claude/skills/vpn-debug/` — 早期 VPN 专用诊断技能(本预设的超集前身,含 diagnose.sh)
- `AGENTS.md` — 安全规则与 showboat 规范总纲
