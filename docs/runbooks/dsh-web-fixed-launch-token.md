# Runbook: 固定 dsh Web 启动 token(fixed launch token)

适用场景:不经常升级 dsh 的服务器环境,希望 Web 登录 URL(`http://<host>:<port>/?token=…`)里的 token **跨重启保持不变**,免去每次重启后翻 stdout 日志找新 token 的麻烦。

补丁脚本:`scripts/dsh-web-fixed-launch-token.mjs`(本仓库)。

> 结论先行:上游没有"关掉 token"或"固定 token"的配置项 —— token 由
> `@deepseek-ai/dsh-client-connection` 的 `processLaunchToken()` 用
> `randomBytes(32)` 每进程随机生成、只存内存 WeakMap(源码依据见附录 A,
> 0.1.2-rc.1 与 0.1.3-alpha.1 两代均无开关)。唯一不入侵配置面的办法是
> 对安装好的 release 里的这一份 vendor 文件做内容补丁。

---

## 1. 方案概述

补丁改写 release 内**唯一一份物理** `dsh-client-connection/lib/index.js`
(pnpm 依赖方全部经 symlink 指到它),让 `processLaunchToken()` 变成:

1. 若 `$DSH_HOME/fixed-launch-token` 存在且内容 ≥ 16 字符 → 使用文件内容作为
   launch token;
2. 否则 → 保持上游原行为:`randomBytes(32)` 每进程随机生成。

其余机制全部不动:

- token 仍在每次进程内缓存(WeakMap),仍打印到宿主 stdout 日志
  (`dsh web: http://…/?token=…`),`wake-session.sh` 等"从日志取最后一条
  token"的流程不受影响;
- 签名 cookie 的 HMAC secret 仍在 `$DSH_HOME/.credentials.yaml`,浏览器登录
  一次后的 cookie 照旧跨重启有效;
- 删除 token 文件再重启,即回到随机 token 行为(应急逃生口)。

### 风险与适用边界

| 事项 | 说明 |
| --- | --- |
| 失去轮换 | 固定 token 不随重启轮换;泄露面等于一个长期 API key。token 文件必须 `chmod 600`,属主为运行 dsh 的服务账号。 |
| 公网暴露 | 若宿主经隧道暴露公网(本机生产的 `remote-shili-mac.dsh.onlyservice.io` 即是),token 是唯一门锁,固定后务必保证文件权限,并考虑定期手动轮换(换文件内容 → 重启)。仅内网/回环绑定的服务器风险低得多。 |
| 升级失效 | dsh 升级装的是全新 release 树,补丁消失,token 回到随机。需重跑补丁脚本(见 §5)。适用于"不常升级"的服务器;升级频繁的环境不建议。 |
| 非官方安装 | 补丁是对 vendor 文件的本地修改,偏离官方安装链;排查问题时要记得它的存在(`--check` 一眼可辨)。 |
| 多宿主 | 每个 `$DSH_HOME` 一份 token 文件。同一 home 严禁跑两个宿主(见仓库 AGENTS 的双写者事故),此处不再展开。 |

---

## 2. 操作步骤(服务器通用)

以下命令均在**宿主所在服务器**上、以运行 dsh 的用户执行。

### 2.1 生成固定 token 文件

```bash
# 生成 32 字节 base64url 随机串(43 字符)
TOK=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
umask 077
printf '%s' "$TOK" > "$DSH_HOME/fixed-launch-token"
chmod 600 "$DSH_HOME/fixed-launch-token"
echo "token: $TOK"
```

要点:

- 文件路径固定为 `$DSH_HOME/fixed-launch-token`(补丁按此路径读);
- 内容为**去掉首尾空白后的原样字符串**,任何 ≥16 字符的串都合法,不必拘泥
  base64url;但别用换行结尾(`printf`,不是 `echo`);
- **绝不要**把 token 写进任何 `.env` 文件(`DSH_` 前缀/env 契约会拒绝启动);
  也不要写进 shell profile 的公共文件。

### 2.2 把补丁脚本带上服务器

```bash
# 服务器能访问 GitHub 时:
curl -fsSL -o /tmp/dsh-web-fixed-launch-token.mjs \
  https://raw.githubusercontent.com/shiliai/dsh-plugins/main/scripts/dsh-web-fixed-launch-token.mjs
# 或从本机 scp:
#   scp scripts/dsh-web-fixed-launch-token.mjs server:/tmp/
```

### 2.3 定位 release 根并预检

```bash
# release 根 = 含 node_modules/.pnpm 的目录,例如:
#   ~/.local/share/dsh-cli/releases/<version>
# 自动探测(从 `which dsh` 向上找);不行就 --release 显式给:
node /tmp/dsh-web-fixed-launch-token.mjs --check            # 退出码 3 = 未打补丁
node /tmp/dsh-web-fixed-launch-token.mjs --check \
  --release ~/.local/share/dsh-cli/releases/<version>
```

`--check` 会列出它找到的物理 `dsh-client-connection/lib/index.js`(正常每
个 release 恰好一份)并报告已打/未打。

### 2.4 打补丁

```bash
node /tmp/dsh-web-fixed-launch-token.mjs --apply --release <release-root>
```

行为:

- 校验上游 `processLaunchToken` 函数体锚点存在且唯一,否则**报错拒绝**(
  说明该 release 的代码形状变了,需按附录 A 重新推导补丁);
- 自动在目标旁备份 `lib/index.js.orig`(已存在则不覆盖,保留最早的原件);
- 写入前先对补丁结果跑 `node --check` 语法校验,失败即中止不落盘;
- 幂等:对已打补丁的文件是 no-op。

### 2.5 外部重启 dsh 宿主

补丁只改磁盘文件;**正在运行的宿主进程仍执行旧模块**,必须由进程外的
方式重启(严禁从该宿主自己托管的会话里重启,本仓库机器的规约见 AGENTS.md
"DSH restart safety";普通服务器就是用 systemd/launchd/管理员终端重启服务):

```bash
# systemd 示例
sudo systemctl restart dsh-web
# launchd 示例
launchctl kickstart -k gui/$(id -u)/<service-label>
```

重启前确认旧进程已退出、端口已释放再放行新进程(单写者原则)。

### 2.6 验证

```bash
# 1) stdout 日志打印的 URL 应携带固定 token
grep -o 'token=[A-Za-z0-9_-]*' <宿主stdout日志> | tail -1
#    应等于: cat $DSH_HOME/fixed-launch-token

# 2) token 换 cookie 的握手应返回 303
curl -s -o /dev/null -w '%{http_code}\n' \
  "http://127.0.0.1:<port>/?token=$(cat $DSH_HOME/fixed-launch-token)"
#    预期:303(Set-Cookie dsh-auth-…;303 到 /)

# 3) 错误 token 应返回 401
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:<port>/?token=wrong"
#    预期:401

# 4) 重启一次,确认 stdout 里 token 不再变化;浏览器旧 cookie 依旧有效
```

本机(参考机)补充:生产 3280 的 stdout 日志在
`~/.local/state/dsh-remote-agent/runtime/dsh.stdout.log`,测试 5280 在
`~/.local/state/dsh-dev/dsh-dev-5280.stdout.log`。给这两个环境打补丁后,
分别按 AGENTS.md 的互救流程外部重启(生产用 `scripts/prod-restart.sh` /
`prod-restart-request.sh`,测试用 `scripts/dev-service.sh restart`)。

---

## 3. 回滚

```bash
node /tmp/dsh-web-fixed-launch-token.mjs --revert --release <release-root>
# 或手工:把 lib/index.js.orig 拷回 lib/index.js
# 再重启宿主;随后回到随机 token 行为
```

只想临时"换一个"固定 token:改写 `$DSH_HOME/fixed-launch-token` 内容后重启,
无需动补丁。想彻底放弃固定:删除该文件后重启即可(补丁留在原地无害)。

---

## 4. 效果与行为变化一览

| 行为 | 打补丁前 | 打补丁后 |
| --- | --- | --- |
| 每次 `dsh web` 启动 | 新随机 token | token == `$DSH_HOME/fixed-launch-token` |
| 文件不存在/内容 <16 字符 | — | 回退随机 token(原行为) |
| token 出处 | 仅宿主 stdout 日志 | 同左(值固定),另加 token 文件本身 |
| cookie 跨重启 | 有效(HMAC secret 持久) | 不变 |
| `wake-session.sh` 等从日志取 token | 每次重启后值变化 | 值恒定 |
| 删除 token 文件 + 重启 | — | 回到随机 token(逃生口) |

---

## 5. dsh 升级之后

新 release = 全新 vendor 树,补丁不存在。固定 token 会"悄悄"失效一次:重启后
stdout 里的 token 变回随机值,浏览器需用新 token 重新登录一次(cookie 的
HMAC secret 未变,已登录的浏览器不受影响)。之后:

```bash
node /tmp/dsh-web-fixed-launch-token.mjs --check  --release <new-release-root>   # 预期 exit 3
node /tmp/dsh-web-fixed-launch-token.mjs --apply  --release <new-release-root>
# 再外部重启一次
```

`--apply` 遇到锚点不匹配会**显式报错**而不是盲改 —— 那说明新版本的
`processLaunchToken` 代码形状变了,按附录 A 重新人工核对锚点、更新脚本后
再用。已验证锚点在 0.1.2-rc.1 与 0.1.3-alpha.1 完全一致。

---

## 附录 A:补丁内容(供人工核对)

改动文件:`node_modules/.pnpm/@deepseek-ai+dsh-client-connection@<v>_<hash>/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js`(release 树内唯一物理副本)。

上游代码(`processLaunchToken`,tab 缩进,两代版本逐字节一致):

```js
const PROCESS_LAUNCH_TOKENS = /* @__PURE__ */ new WeakMap();
function processLaunchToken(owner) {
	const existing = PROCESS_LAUNCH_TOKENS.get(owner);
	if (existing !== void 0) return existing;
	const created = encodeBase64Url(randomBytes(SECRET_BYTES));
	PROCESS_LAUNCH_TOKENS.set(owner, created);
	return created;
}
```

补丁后(第一行注释即补丁标识,`--check` 据此识别):

```js
/* dsh-fixed-launch-token-patch v1: fixed token from $DSH_HOME/fixed-launch-token */
function processLaunchToken(owner) {
	const existing = PROCESS_LAUNCH_TOKENS.get(owner);
	if (existing !== void 0) return existing;
	let created;
	try {
		const fixed = readFileSync(`${process.env.DSH_HOME ?? ""}/fixed-launch-token`, "utf8").trim();
		if (fixed.length >= 16) created = fixed;
	} catch {
	}
	if (created === void 0) created = encodeBase64Url(randomBytes(SECRET_BYTES));
	PROCESS_LAUNCH_TOKENS.set(owner, created);
	return created;
}
```

外加一行 import(锚在既有 `node:crypto` 导入之后):
`import { readFileSync } from "node:fs";`

源码事实(为什么只能这么改):

- token 生成点:`client-connection/lib/index.js` 的 `processLaunchToken()` →
  `encodeBase64Url(randomBytes(32))`,存进程内 WeakMap,**无任何读盘/配置入口**;
- 配置 schema(`Config = z.object({ trustedHosts, cookieMaxAgeDays, maxRequestBodyBytes })`)
  没有 auth 开关;`authorizeIndex()` 无条件要求"有效 token 或有效 cookie";
- `--trusted-host` 只放宽 `/api` 的 Host/Origin 栅栏,与 token 认证无关;
- cookie 签名 secret 持久在 `$DSH_HOME/.credentials.yaml` 的
  `records["client-connection/browser-session"]`,与本补丁无关、不受影响。

## 附录 B:脚本速查

```bash
node scripts/dsh-web-fixed-launch-token.mjs --check  [--release <dir>]   # exit 0=已打 3=未打 1=错
node scripts/dsh-web-fixed-launch-token.mjs --apply  [--release <dir>]   # 幂等;自动备份+语法校验
node scripts/dsh-web-fixed-launch-token.mjs --revert [--release <dir>]   # 恢复 lib/index.js.orig
```

备份文件:目标旁的 `lib/index.js.orig`(首次 apply 时创建,之后不覆盖)。
