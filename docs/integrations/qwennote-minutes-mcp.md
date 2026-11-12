---
description: "qwennote minutes(钉钉闪记)MCP 集成指南:如何把 minutes.qwennote.cn 接入 dsh 的 mcp-client、OAuth 凭据续期与重授权、定时抓取转写的 launchd 任务,以及 27 个工具的用法要点。"
kind: "integration-guide"
---

# qwennote minutes MCP 集成(钉钉闪记转写)

把 `https://minutes.qwennote.cn/mcp` 接入 DSH 的 `@deepseek-ai/dsh-mcp-client`,使会话可直接查询/编辑用户的录音转写笔记。该服务不是本仓库的插件包,而是「外部 MCP + 本机凭据/定时脚本」的集成,故记录在 `docs/integrations/`。

## 1. dsh 配置

在目标 profile 的用户 patch 层(`$DSH_HOME/profiles/<profile>/cordis.patch.yml`)追加条目;dsh HMR 会监听该文件并在变更时热加载 MCP 连接:

```yaml
- insert:
    - id: mcp-qwennote-minutes
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: qwennote_minutes
        transport: streamable-http
        url: https://minutes.qwennote.cn/mcp
        headers:
          Authorization: Bearer <access_token>
```

- 新增行必须放在顶层 `- insert:` 列表里。profile patch 的顶层 `- id: <name>` 条目是按 id **覆盖已有行**,直接写顶层会得到 `patch: entry "mcp-qwennote-minutes" not found` 并被静默忽略(不报错、不加载)。改完用 `dsh --profile <profile> --dump-config` 校验条目确实出现在组合结果里。
- 工具以 `mcp__qwennote_minutes__<tool>` 暴露,共 27 个。
- `dsh-mcp-client` 只接受**静态 header**,不内置 OAuth 流程;token 必须由外部流程获取并写入配置。
- 不要把 token 提交进仓库;它只存在于 `$DSH_HOME` 下的凭据文件与 profile patch。

## 2. OAuth 凭据生命周期

服务方要求 OAuth 授权码流程(授权服务器 `https://minutes.qwennote.cn`,PKCE S256,`token_endpoint_auth_method: none`,scope `qwennote:read qwennote:write`)。

| 步骤 | 命令/文件 | 说明 |
|---|---|---|
| 首次授权/重授权 | `node $DSH_HOME/qwennote-minutes-auth.mjs` | 自动开浏览器完成登录授权,回调 `http://127.0.0.1:8799/callback`,成功后写凭据文件 |
| 凭据存储 | `$DSH_HOME/qwennote-minutes.auth.json`(0600) | `access_token`/`refresh_token`/`expires_at`/`client_id` |
| 自动续期 | `node $DSH_HOME/qwennote-minutes-refresh.mjs` | 到期前 10 分钟用 refresh_token 换新,并**同步改写** patch 中的 `Authorization` 行(触发 HMR 重连) |
| 定时续期 | launchd `cn.qwennote.minutes-mcp-refresh`,每 15 分钟 | 日志 `$DSH_HOME/qwennote-minutes-refresh.log` |

- 已注册 OAuth client:`qnmcp-59bac78074a54306ba98ee1dfb08db5e`(固定回调端口 8799,授权时该端口需空闲)。重授权脚本必须复用该 client 注册时的 redirect URI;换端口需重新注册 client。
- access_token 1 小时过期;脚本化调用遇 401 时先执行 `node $DSH_HOME/qwennote-minutes-refresh.mjs --force` 再重试。
- 若 refresh_token 也失效(长期未开机等),重跑重授权脚本即可,无需重新注册 client。

## 3. 定时抓取转写

`node $DSH_HOME/qwennote-minutes-fetch-latest.mjs` 抓取「最新一篇转写已生成且未保存」的笔记,存为工作目录下 `minutes/YYYY-MM-DD_<标题>.md`(`[mm:ss] 发言人: 内容` 逐段),状态存 `minutes/.fetch-state.json` 去重。launchd `cn.qwennote.minutes-fetch-latest` 的 `StartInterval` 可按需设置(示例每天 09:00;本机实际采用 1800 秒即每 30 分钟),日志 `$DSH_HOME/qwennote-minutes-fetch.log`;转写未生成的笔记会跳过并在下次重试。抓取脚本应先执行续期检查(`qwennote-minutes-refresh.mjs`),token 失效时先续期再调用工具,避免 401。

两个 launchd 任务都是**用户级**代理(`~/Library/LaunchAgents/`),手动触发:`launchctl kickstart gui/$(id -u)/cn.qwennote.minutes-fetch-latest`。

## 4. 工具要点

- `list_my_minutes`:`pageSize` 1–20,分页游标必须携带同组 `createdAfter`/`createdBefore`;返回顺序不保证,按 `gmtCreate` 自行排序。
- `get_minutes_transcription`:`taskUuid` 来自 `list_my_minutes`;分页 `nextToken` 不透明且必须与 `direction` 保持一致(0 正序/1 倒序),`maxResults` ≤500;无段落时返回空数组并附说明(转写未完成)。
- 其余:`get_minutes_basic_info`、`get_minutes_ai_summary`、`get_minutes_keywords`、`list_minutes_todos`、`get_minutes_media_url`(限时播放地址)、标签/热词/摘要模板管理类工具。
- 直连调用(不经 dsh 工具):JSON-RPC 2.0 POST 到 endpoint,`params: { name, arguments }`,结果在 `.result.content[0].text`(JSON 字符串,需二次解析);服务端不强制先 `initialize`。

## 5. 已知限制

- 转写生成在服务端异步完成;刚录完的笔记可能长时间无段落,只能轮询重试。
- 图片仅以 S3 链接形式提供(需另行批量下载)。
- MCP prompt 模板不支持;资源按需读取。
