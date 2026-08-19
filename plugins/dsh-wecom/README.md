# dsh-wecom

`dsh-wecom` is a resident WeCom smart-robot long-connection bridge for DeepSeek
Harness. It keeps conversation memory only for the lifetime of the DSH process;
restarting the process deliberately starts new conversations.

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
      inject: [tools, agents, agentDefaultModel, agentPresets, sessions]
      config:
        botId: !!js process.env.WECOM_BOT_ID ?? ''
        botSecret: !!js process.env.WECOM_BOT_SECRET ?? ''
        # Empty is deny. '*' explicitly permits all direct chats.
        allowChats: ['userid-a', 'group-chat-id']
        # A group also requires its sender to be allowed; empty is deny.
        allowGroupSenders: ['userid-a']
        # Agent-initiated messages use this separate default-deny allowlist.
        outboundAllowChats: ['userid-a']
        defaultCwd: '/srv/dsh-workspace'
        allowedCwdRoots: ['/srv/dsh-workspace']
        # Optional. Without this, agentPresets.defaultId is used.
        defaultPreset: 'standard'
        maxLiveChats: 100
        idleChatMs: 1800000
```

`allowChats` authorizes direct chats by chat id or userid. For a group it
authorizes the group id, and `allowGroupSenders` must separately authorize the
sender userid. Use `'*'` only as an intentional full allowlist. There is no
`denyListReply` setting: denied messages receive no response.

`/cd` first resolves the target with `realpath`, then requires it to be under
`allowedCwdRoots`. This blocks absolute-path, `..`, and symlink escapes. With
no roots configured, only `defaultCwd` (or `process.cwd()`) and its descendants
are available.

## Commands

| Command | Effect |
| --- | --- |
| `/help` | Show commands |
| `/new` | Start a new in-process session generation |
| `/cd [directory]` | Show or change to an allowed working directory |
| `/pwd` | Show the current working directory |
| `/agent [preset-id-or-unique-name]` | List or switch a valid preset |
| `/status` | Show session, directory, preset, and the live agent model |

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
  and generation. The bridge never resumes persistent sessions, so `/new` and a
  plugin reload cannot revive an old generation.
- Queue entries are removed after settlement. Live chat states are bounded by
  `maxLiveChats` and idle eviction. In-flight queues are drained before plugin
  unload disposes their agents. Configure values for the expected traffic.

## Verification

```sh
pnpm --filter @dsh-plugins/dsh-wecom check
pnpm --filter @dsh-plugins/dsh-wecom pack:check
pnpm --filter @dsh-plugins/dsh-wecom release:check
```

The test suite uses fakes for DSH and the WeCom SDK. It does not perform a live
WeCom credential, network, or production-profile end-to-end test.
