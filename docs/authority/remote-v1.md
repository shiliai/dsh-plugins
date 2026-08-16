# Remote Access User-Story Baseline

Baseline revision: `remote-v1`

## Authority Sources

User request, 2026-08-16:

> 创建目录 dsh-remote: 为当前部署的 dsh 开发 remote 访问插件，目标是通过 host vps-tencent-tokyo (通过 ssh 可以访问）可以访问当前运行的 dsh 网站。 vps 上已经有nginx/let'encrpyt 等组件，注册为 zsh.onlyservice.io 域名访问，访问方式为域名后面加唯一随机数，这样用户不需要额外登录信息。这块要从用户体验出发。

Lifecycle decision: the user accepted a persistent private link with explicit
rotation by replying `好的` after that recommendation.

Baseline approval: the user replied `确认` to the three stories below.

Design and execution approval: after the complete architecture, access flow,
component, setup, failure, and alignment playback was presented, the user replied
`确认，开始执行`.

## Required Stories

### US-R1

As the DSH owner, I want to open one long-lived private link on any device without
entering account credentials, so that I can use the complete currently running
DSH, including realtime connections.

- Given local DSH and the tunnel are online
- When the owner opens `https://zsh.onlyservice.io/#/access/<token>`
- Then the browser establishes a secure session and enters DSH, with refresh,
  root-relative resources, APIs, and WebSocket traffic working normally

### US-R2

As the DSH owner, I want to inspect remote status, copy the private link, and
rotate it, so that I can manage access without editing server configuration.

- Given remote access has been configured
- When the owner rotates the link
- Then all old links and sessions become invalid immediately and one new
  persistent link is available to copy

### US-R3

As the DSH owner, I want a clear unavailable page when local DSH or its tunnel is
offline, so that I do not see an opaque proxy error or login prompt.

- Given the public site is configured but the tunnel cannot serve DSH
- When the owner opens the remote URL
- Then the VPS returns a minimal branded `503` page with a retry action and no
  infrastructure details

## Constraints

- Public traffic enters only through HTTPS on the named VPS.
- Access uses a high-entropy bearer link with no additional login prompt.
- The link remains valid across normal DSH restarts until explicitly rotated.
- Rotation invalidates earlier links and sessions.
- No DSH data is persisted on the VPS.
- No public reverse-tunnel TCP port is introduced.

## Non-goals

- Account, password, OAuth, invitation, or multi-user authorization systems.
- Automatic DNS-provider changes.
- Multiple simultaneous local DSH instances in the first release.

