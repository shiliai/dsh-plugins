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

## Connection status and plugin restart

Use the WeCom connection button in the DSH sidebar to open the plugin panel.
It updates automatically and shows `unconfigured`, `connecting`, `online`,
`reconnecting`, `offline`, or `error`, together with safe timestamps,
diagnostics, a redacted bot identity, and the plugin version. `online` is shown
only after WeCom authentication succeeds.

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

## Verification

```sh
pnpm --filter @dsh-plugins/dsh-wecom check
pnpm --filter @dsh-plugins/dsh-wecom pack:check
pnpm --filter @dsh-plugins/dsh-wecom release:check
```

The validation target for this feature release is `@dsh-plugins/dsh-wecom@0.3.0`.

The test suite uses fakes for DSH and the WeCom SDK. It does not perform a live
WeCom credential, network, or production-profile end-to-end test.
