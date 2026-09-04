# dsh-wecom

`dsh-wecom` is a resident WeCom smart-robot long-connection bridge for DeepSeek
Harness. It keeps conversation memory only for the lifetime of the DSH process;
restarting the process deliberately starts new conversations.

To let each chat's conversation survive process restarts and plugin reloads,
set `resumeSessions: true` (see [Configuration](#configuration)); the bridge then
resumes the latest persisted `wecom:` session for the chat instead of starting
fresh, falling back to a fresh session when the persistence service is
unavailable or nothing is persisted. A chat can also be bound to an existing
DSH web session (`/sessions`, `/attach`, or `bindSession`) so the WeCom bot and
the browser share one conversation log. When a chat is bound, the sync is
bidirectional: the bot writes WeCom messages into that session (visible in the
browser), and messages the user sends from the browser on that session are
mirrored back to the WeCom chat together with the assistant's replies (see
`mirrorWebToWecom`). Session bindings are organized around an
action workspace (see `defaultWorkspace`): `/new` starts a fresh session there
and `/sessions` lists or binds the persisted sessions under the current
directory.

## Install

Install the public GitHub subdirectory package through DSH. Do not use a local
path, `link:`, or tarball as the public installation source.

```sh
dsh plugin --profile web config set --location=project --json allowBuilds \
  '{"@dsh-plugins/dsh-wecom@git+https://github.com/shiliai/dsh-plugins.git":true,"@dsh-plugins/dsh-wecom@git+ssh://git@github.com/shiliai/dsh-plugins.git":true}'
dsh plugin --profile web add \
  'github:shiliai/dsh-plugins#path:/plugins/dsh-wecom'
```

For updates, always use the repository updater so pnpm resolves the current Git
revision rather than relying on `pnpm outdated`:

```sh
dsh plugin --profile web --config.dlx-cache-max-age=0 dlx \
  'github:shiliai/dsh-plugins#path:/scripts/dsh-plugin-updater' check @dsh-plugins/dsh-wecom
dsh plugin --profile web --config.dlx-cache-max-age=0 dlx \
  'github:shiliai/dsh-plugins#path:/scripts/dsh-plugin-updater' update @dsh-plugins/dsh-wecom
```

Restart the profile after installation or update.

## Configuration

Keep credentials in the environment. The shipped patch reads these values and
does not grant any chat access by default.

```sh
export WECOM_BOT_ID=your-bot-id
export WECOM_BOT_SECRET=your-bot-secret
```

Add a user patch with explicit identities and roots appropriate for the host:

```yaml
- insert:
    - id: dsh-wecom
      name: '@dsh-plugins/dsh-wecom'
      inject: [tools, agents, agentDefaultModel, agentPresets, sessions, webServer]
      config:
        botId: !!js process.env.WECOM_BOT_ID ?? ''
        botSecret: !!js process.env.WECOM_BOT_SECRET ?? ''
        # Empty is deny. '*' explicitly permits all direct chats.
        allowChats: ['userid-a', 'group-chat-id']
        # A group also requires its sender to be allowed; empty is deny.
        allowGroupSenders: ['userid-a']
        # Agent-initiated messages use this separate default-deny allowlist.
        outboundAllowChats: ['userid-a']
        # Authorization watchdog (see "Authorization layers and the watchdog").
        # alertChatId / webhookUrl are the alert destinations; leave unset for log-only.
        authWatchdog:
          enabled: true
          checkIntervalMs: 60000
          minDowntimeMs: 120000
          alertCooldownMs: 3600000
          alertChatId: 'userid-a'
          webhookUrl: 'https://example.com/hooks/wecom-alerts'
        # Diagnostic verbosity: error | warn | info (default) | debug.
        logLevel: 'info'
        # Trusted browser origin for the restart action. Local DSH defaults to this value.
        managementOrigin: 'http://127.0.0.1:3180'
        defaultCwd: '/srv/dsh-workspace'
        allowedCwdRoots: ['/srv/dsh-workspace']
        # Optional. Action workspace where /new starts a fresh session and
        # sessions are organized by directory (see /sessions). Defaults to
        # ~/project/wecom-workspace.
        defaultWorkspace: '/srv/dsh-workspace/wecom-workspace'
        # Optional. Without this, agentPresets.defaultId is used.
        defaultPreset: 'standard'
        maxLiveChats: 100
        idleChatMs: 1800000
        # Optional. Resume this chat's latest persisted `wecom:` session across
        # process restarts instead of starting fresh. Requires the host's
        # sessionPersistence service (the web profile ships
        # dsh-session-persistence-jsonl). Falls back to a fresh session when
        # unavailable or nothing is persisted. Defaults to false.
        resumeSessions: true
        # Optional. Bind a chat (key `"type:chatId"`) to an existing DSH web
        # session id to share one conversation log. The target must be persisted
        # and idle (not active in the browser). Prefer /sessions and /attach for
        # runtime binding.
        bindSession:
          'single:userid-a': 'some-web-session-id'
        # Optional. Mirror DSH web activity back to WeCom. When a chat is bound
        # to a shared `session-<uuid>` (bindSession, /attach, /sessions <id>, or
        # /new), messages the user sends in the browser on that session — and the
        # assistant's replies — are forwarded to the bound WeCom chat, so the
        # conversation is visible in both directions. Never loops (the plugin's
        # own wecom->web forwards are detected and skipped). Defaults to true.
        mirrorWebToWecom: true
        # Optional. Show a "thinking" placeholder on WeCom while an agent turn
        # runs, then replace it with the reply via a streaming reply, so the user
        # knows the bot received the message and is working. Defaults to true.
        showThinking: true
        # Optional. Placeholder text shown while thinking. Defaults to "🤔 思考中…".
        thinkingText: '🤔 思考中…'
        # Optional. Persist runtime chat->web-session bindings (/attach, /sessions,
        # /new) across process restarts, so a bound chat keeps pointing at its
        # shared web session after a restart. Stored in
        # <defaultWorkspace>/.dsh-wecom-bindings.json. Defaults to true.
        persistBindings: true
```

`allowChats` authorizes direct chats by chat id or userid. For a group it
authorizes the group id, and `allowGroupSenders` must separately authorize the
sender userid. Use `'*'` only as an intentional full allowlist. There is no
`denyListReply` setting: denied messages receive no response.

### Diagnostics / logging

The plugin logs every line with a `[dsh-wecom]` prefix. By default (`info`) it
writes one line per inbound message, per slash command, per agent creation /
generation reset, and the SDK's connect / auth / disconnect lifecycle (e.g.
`Authentication successful`). Set `logLevel: 'debug'` for extra per-turn and
per-reply detail.

Privacy is preserved at every level: logs never include message bodies, tokens,
or raw frames — only identities (chat id / chat type / msg id) and byte
counts. The WeCom SDK's own `debug` logs (which serialize frame bodies) are
always dropped, even at `debug`. Only identity and metadata are emitted.

`/cd` first resolves the target with `realpath`, then requires it to be under
`allowedCwdRoots`. This blocks absolute-path, `..`, and symlink escapes. With
no roots configured, only `defaultCwd` (or `process.cwd()`) and its descendants
are available.

## Connection status, WeCom CLI update, and plugin restart

Use the WeCom connection button in the DSH sidebar to open the plugin panel.
It updates automatically and shows `unconfigured`, `connecting`, `online`,
`reconnecting`, `offline`, or `error`, together with safe timestamps,
diagnostics, a redacted bot identity, and the plugin version. `online` is shown
only after WeCom authentication succeeds.

The panel can also compare the installed `wecom-cli` version with the latest
official `@wecom/cli` release on npm. When an update is available, the Update
button runs the official global installation command (`npm install -g
@wecom/cli@latest`) and verifies the installed version afterwards. Updating the
standalone CLI does not require a DSH restart. The fixed package name and
arguments are not derived from browser input.

The panel's Restart action rebuilds only the `dsh-wecom` bridge and long
connection. It first asks for confirmation because process-local WeCom
conversations are reset. The action is serialized: repeated clicks reuse the
same restart, disconnect and dispose the old pair before one replacement is
created, and then report either the new connection state or a safe instruction
to check credentials and network. It does not restart DSH or edit profile
configuration.

For an `unconfigured` status, update the DSH profile environment with both
credential variables and restart the DSH profile. A plugin-only restart cannot
read a changed parent-process environment. Configure `managementOrigin` for a
non-local DSH browser origin; its exact scheme, host, and port authorize the
restart action. The local default is `http://127.0.0.1:3180`.

The status API deliberately never returns `botSecret`, tokens, message bodies,
or WebSocket frames. Its restart endpoint accepts only the configured trusted
origin and rejects cross-site browser fetches.

## Authorization layers and the watchdog

WeCom authorization has **two independent layers** that must be understood
separately, because only one of them is renewed automatically:

1. **The WebSocket long-connection credential** (`botId` + `botSecret`). The
   smart-robot SDK owns connect/auth/heartbeat/reconnect on this layer. When an
   API call returns errcode `853004` (token expired/invalid), the WeCom CLI
   chain silently mints a new access token from the bot credentials and replays
   the request — no manual action is needed
   ([wecom-cli CHANGELOG](https://github.com/WecomTeam/wecom-cli/blob/main/CHANGELOG.md)).
   If the `botSecret` itself is wrong or revoked, the SDK surfaces an
   `Authentication failed` / `WS_AUTH_FAILURE_EXHAUSTED` error and keeps
   retrying.

2. **WeCom "数据权限 / 定期授权" (data-permission periodic authorization)**. This
   grants the bot access to data via the HTTP APIs and is valid **90 days**, not
   indefinitely ([获取数据权限接入指引](https://developer.work.weixin.qq.com/document/path/101545)).
   WeCom pushes an **`auth_data_permission`** event (a `指令回调` callback) once,
   7 days before expiry, and shows admin-side reminders at 7/3/1 days and on the
   expiry day; re-authorizing in the admin console restarts the 90 days
   ([数据权限授权和到期事件](https://developer.work.weixin.qq.com/document/path/101587)).

This layer is **not** auto-renewed and will silently break API access when it
lapses. That is what the plugin's authorization watchdog watches for and reports
instead of failing silently.

### How the watchdog works

The watchdog is enabled by default and observes the same `WecomLifecycleEvent`s
the plugin already emits for the long connection (`connected` / `authenticated`
/ `disconnected` / `reconnecting` / `error`). It enters a `degraded` state when
authorization becomes unavailable — an SDK auth error (for example
`WS_AUTH_FAILURE_EXHAUSTED` or an `Authentication failed (code: <errcode>)`),
any other SDK error, or a connection that has stayed down for a while. After the
connection has been degraded for at least `minDowntimeMs` (default 2 minutes —
this filters transient reconnect blips) it raises an **alert**. While the
degradation persists it re-alerts at most once per `alertCooldownMs` (default
1 hour), so a silent failure is surfaced repeatedly until it is resolved.

An alert is delivered to every configured destination:

- **WeCom chat** — `authWatchdog.alertChatId` (a user `userid` or group
  `chatid`) is sent a Markdown alert through the resident bot.
- **HTTP webhook** — `authWatchdog.webhookUrl` is POSTed a JSON payload
  (`{ text, summary, kind, code, detail, at }`) for email/log bridges.
- **Log** — a `[dsh-wecom]` `error`-level line is always written.

With neither destination set, alerts are log-only. The alert body identifies the
degradation kind (`auth` / `connection` / `unknown`) and the real diagnostic
code, and, for `auth` degradations, instructs the operator to re-authorize data
permission (see the diagnosis note below). The watchdog never blocks the bot —
it is purely observational, and its state is exposed on the plugin status API as
`status.watchdog` (`healthy` / `degraded` / `disabled`).

### Configuration reference

| Key | Default | Meaning |
| --- | --- | --- |
| `authWatchdog.enabled` | `true` | Master switch; `false` disables monitoring. |
| `authWatchdog.checkIntervalMs` | `60000` | How often the watchdog re-evaluates and re-alerts. Clamped to ≥ 5000 ms. |
| `authWatchdog.minDowntimeMs` | `120000` | Sustained downtime before the first alert; filters reconnect noise. Clamped to ≥ 5000 ms. |
| `authWatchdog.alertCooldownMs` | `3600000` | Minimum gap between repeated alerts while still degraded. Clamped to ≥ 30000 ms. |
| `authWatchdog.alertChatId` | (none) | WeCom chat to send alerts to via the bot. |
| `authWatchdog.webhookUrl` | (none) | HTTP(S) URL POSTed alert JSON for log/email bridges. |

### Backend callback settings and the renewal extension point

The plugin runs a WebSocket long connection, **not** an HTTP callback server, so
it cannot receive WeCom's `auth_data_permission` (`指令回调`) event in-process.
To get a **proactive** renewal reminder before expiry, an operator must:

1. Configure a WeCom **指令回调** (callback) receiver with a public HTTPS URL,
   verifying it with WeCom's URL + `echostr` challenge, and set the callback
   token / `EncodingAESKey` for decrypting push payloads.
2. Subscribe to the `auth_data_permission` event (pushed once, 7 days before
   expiry).
3. On receiving the event, call the plugin's extension point
   `AuthWatchdog.notifyDataPermissionExpiry(detail)` (exported from the plugin
   package) with the detail from the push. This raises an immediate `auth`
   renewal-reminder alert through the same configured destinations, so the
   operator is reminded *before* any breakage.

The exact callback URL/token settings are decided by the operator's WeCom admin
console, so they are documented here rather than configured in this plugin. If
no callback receiver is run, the watchdog still catches a lapse reactively: the
moment API access actually breaks (or the long connection stops authenticating),
the real error code is surfaced in an alert as described above.

### How to diagnose the authorization state

Do not assume the authorization lifetime or the failure cause — **capture the
real signal**:

- The watchdog exposes the last observed code via `GET /dsh-wecom/api/status`
  at `status.watchdog.code` (an errcode integer such as `853004`, or an SDK
  code such as `WS_AUTH_FAILURE_EXHAUSTED` / `WS_RECONNECT_EXHAUSTED`), and
  `status.watchdog.kind` (`auth` / `connection` / `unknown`).
- The plugin log writes `[dsh-wecom] sdk: Authentication failed:
  errcode=..., errmsg=...` when the SDK rejects the subscription, and
  `watchdog: degradation began { kind, code }` lines.

The WeCom docs state data permission is valid 90 days with a 7-day-before
expiry event. If an operator has observed authorization drop after roughly "1
week", that does **not** match the documented 90-day rule — check the actual
errcode/event that surfaced (token `853004`/`40001`, API-scope errors such as
`48002`, or a data-permission expiry) before changing configuration. The
watchdog's `code` field is there so the operator reports the real value rather
than guessing.

## Commands

| Command | Effect |
| --- | --- |
| `/help` | Show commands |
| `/new` | Start a fresh session rooted at the action workspace |
| `/cd [directory]` | Show or change to an allowed working directory |
| `/pwd` | Show the current working directory |
| `/agent [preset-id-or-unique-name]` | List or switch a valid preset |
| `/status` | Show session, directory, preset, and the live agent model |
| `/sessions [session-id]` | List persisted sessions under the current directory; with an id, bind to that session |
| `/attach [session-id]` | Bind to a DSH web session to share a conversation (no arg shows current binding) |
| `/detach` | Unbind and return to this chat's own session |

Preset ids are the stable contract. A display name is accepted only when it is
unique. Broken presets are rejected before session creation. When
`defaultPreset` is omitted, `agentPresets.defaultId` is resolved, mounted, and
recorded consistently in the session metadata and command/status output.

## Operational notes

- Inbound delivery is deduplicated by bot identity and WeCom `msgid` with a
  bounded ten-minute TTL cache. This covers ordinary messages and commands.
- Replies and `wecom_send_message` payloads are limited to 20,480 UTF-8 bytes
  without splitting a Unicode code point. The bridge sends a finished stream
  reply after the agent turn; it does not promise a five-second first frame.
  WeCom documents a ten-minute limit after streaming has begun.
- Session ids include bot namespace, chat type, chat identity, process epoch,
  and generation. By default the bridge never resumes persistent sessions, so
  `/new` and a plugin-only restart cannot revive an old generation. With
  `resumeSessions: true`, the process epoch is dropped from the id (so ids are
  stable across restarts) and the latest persisted generation is resumed on
  startup; `/new`, `/cd`, and `/agent` still start a fresh generation. A bound
  chat instead resumes its bound web session id (see `/sessions`, `/attach`,
  `bindSession`), refused with a clear message if that session is live in the
  browser.
- Queue entries are removed after settlement. Live chat states are bounded by
  `maxLiveChats` and idle eviction. In-flight queues are drained before plugin
  unload disposes their agents. Configure values for the expected traffic.

## Interactive questions (selectable template cards)

Plain WeCom text/stream replies cannot render tappable options, so the plugin
bridges the agent's `ask_user_question` tool to an interactive
`multiple_interaction` template card (official docs:
[被动回复消息](https://developer.work.weixin.qq.com/document/path/101031) and
[智能机器人长连接](https://developer.work.weixin.qq.com/document/path/101463)).

When an agent asks a single-select question with up to **5** options, the bridge:

1. Registers channel `wecom` on the routed `ctx.userQuestions` service and renders the question
   as a `multiple_interaction` card (a dropdown of options plus a submit button).
2. `WecomBot` normalizes the resulting `event.template_card_event` and routes it
   to the bridge, which matches the card by its `task_id` and calls
   `updateTemplateCard` to show the chosen option.
3. The selection is delivered back into the **same** DSH session as the tool
   result of the `ask_user_question` call, so the conversation continues with the
   user's choice in context.

Fallbacks, per the issue acceptance criteria:

- A question with **no options**, **more than 5 options**, or a **multi-select**
  layout cannot be card-rendered. The bridge sends it as readable numbered text
  so it is still visible, then releases the turn.
- DSH versions without routed providers keep the bot connected and report the
  question capability as `unsupported`; they never turn this optional feature
  into a connection failure.
- The existing plain-text/stream reply path is unchanged for every non-question
  turn.

### Coexistence with the DSH browser

The browser registers channel `web` and this plugin registers channel `wecom`,
so both providers remain active in one process. The host writes a trusted route
onto the message that opens each turn. `ask_user_question` copies that route into
its internal request without exposing it in the model tool schema. Web-origin
turns therefore ask only in Web; WeCom-origin turns ask only in their originating
authorized chat, including when both channels successively use one bound session.
Route-less legacy requests use Web, while an explicit route whose provider is
unavailable fails without crossing channels.

The WeCom provider verifies the route destination, exact live agent, originating
sender, card task id, and pending-question ownership before accepting a tap. The
first valid answer claims the pending question; duplicates, stale cards,
wrong-chat and wrong-sender events are ignored. Abort, timeout, provider disposal,
and plugin unload each settle pending questions once. Optional provider or
bindings failures are exposed independently from connection startup.

## Verification

```sh
pnpm --filter @dsh-plugins/dsh-wecom check
pnpm --filter @dsh-plugins/dsh-wecom pack:check
pnpm --filter @dsh-plugins/dsh-wecom release:check
```

The validation target for this feature release is `@dsh-plugins/dsh-wecom@0.5.0`.

The test suite uses fakes for DSH and the WeCom SDK. It does not perform a live
WeCom credential, network, or production-profile end-to-end test.
