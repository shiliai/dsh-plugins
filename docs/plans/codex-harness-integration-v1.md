# Codex Harness Integration Plan

Context: OpenAI released the Codex agent runtime ("Codex Harness") inside the
`openai/codex` repo (Apache-2.0). This plan records the research and the
no-fork, plugin-based approach for bringing the four capabilities that matter
into DeepSeek Harness (DSH) through this repository's plugins.

## Research findings (source of truth)

Cloned codex source: `/Users/chris/project/codex-harness-src` (HEAD
`343074d420`, 2026-08-22). Full notes:
`/Users/chris/project/codex-harness-notes.md` and
`/Users/chris/project/dsh-codex-integration-notes.md`.

The four capabilities and where they live in codex:

1. **Session-to-session communication + viewing other sessions (incl. remote):
   multi-agent/collab tools** `spawn_agent` / `send_input` / `resume_agent` /
   `close_agent` (`codex-rs/core/src/tools/handlers/multi_agents/*`), `AgentControl`
   control plane (`codex-rs/core/src/agent/control.rs`), protocol surface
   `thread/list|read|items/list|turns/list|search|fork|resume`,
   `environment/*` + `remoteControl/*` for remote host sessions.
2. **Schedule independent session+agent and the current session:** `spawn_agent`
   with `fork_context`/`fork_turns` → `SpawnAgentForkMode`, plus `thread/fork`,
   `turn/start`, `turn/steer`, `thread/queue/*`.
3. **Different agents with different model + reasoning effort:** `spawn_agent`
   args `model`, `reasoning_effort`, `service_tier`, `agent_type`;
   `apply_requested_spawn_agent_model_overrides` (`multi_agents_common.rs`).
4. **Memory:** two-phase pipeline (`codex-rs/memories/read` + `write`), read path
   injects cross-session memory as developer instructions with citations; tools
   `memories/search|read|list|add_ad_hoc_note` (`codex-rs/ext/memories`).

## DSH capability gap assessment

| # | Capability | DSH today | Key DSH files |
|---|---|---|---|
| 1 | agent comm + view other sessions | Mostly present in-process: `send_message`/`interrupt_agent`/`list_agents` tools; `session-reference` cross-session read-only snapshots; `session-query` (SQLite FTS). Remote-host sessions: no network transport yet. | `packages/subagent/tool-subagent-control/`, `packages/context/session-reference/`, `packages/session-query/` |
| 2 | schedule independent / current session | Present: `subagent` tool + providers (`spawn`, `fork`, `acp`, `dsh-sdk`, `codex`) + continuable Inbox FIFO. | `packages/subagent/` |
| 3 | per-agent model + effort | Partial: per-child `provider`/`model`/`maxTokens`; `reasoningEffort` not in `AgentOptions`/start schema (exists only at `ModelSelection`/default-model layer). | `packages/core/agent/src/runtime-types.ts`, `model-selection.ts`, `packages/llm/llm/src/call-config.ts` |
| 4 | cross-session memory | Not built in; building blocks exist (`storage-sqlite` KV, `compaction`, `spill`, `session-reference`), plus the `examples/mcp-memory` pattern that mounts an MCP memory server via a cordis.yml plugin. | `packages/storage/`, `packages/compaction/`, `packages/spill/`, `examples/mcp-memory/` |

The existing `packages/subagent/subagent-codex` adapter already runs the real
`codex app-server --stdio` as a subprocess over a minimal JSON-RPC transport
(`thread/start` ephemeral → `turn/start` → `turn/interrupt`), but never reads
agent options (no model/effort pass-through) and is one-shot.

## Decision: plugin, not fork

DSH is built on vendored Cordis with an explicit
everything-is-a-plugin philosophy: "There is no privileged core to patch: you
extend dsh by mounting a plugin beside the others." Features ship on documented
extension points (capability seams, `ctx.tools`, `ctx.subagents`, bundles /
`cordis.patch.yml` profiles). A repository fork is neither required nor
desired. New behavior lands as plugins in this monorepo; the only supporting
in-repo edits needed are small, additive seam fields (e.g. adding an optional
`reasoningEffort` to a start schema), never a fork.

## Implementation steps (phase 1 — minimal usable example)

1. **Per-agent reasoning effort (cap 3, lowest risk).** Add optional
   `reasoningEffort` to the subagent start schema and `AgentOptions`, thread it
   through `ModelSelection`/`installModelSelection`, and expose it to the
   model-facing `subagent` tool. Where the underlying codex harness is used,
   surface it through the `subagent-codex` wire as `turn/start`
   `model`/`reasoning_effort`.
2. **Reuse-session + remote for `subagent-codex` (cap 1b/2 remote path).**
   Extend the adapter from one-shot to `thread/resume`/`thread/list`; give
   `packages/sdk` and ACP an optional network transport so DSH can attach to a
   remote host's session, then re-use `send_message`/inbox for remote input.
3. **Cross-session memory (cap 4).** Build a small `dsh-memory` plugin: read/write
   notes in `ctx.storage` KV (SQLite) keyed by workspace/session, retrieve with
   `session-query` FTS, recall by injecting read-only snapshots via
   `session-reference`. Alternatively reuse the `examples/mcp-memory` MCP-server
   pattern and only add a DSH-side tool/consumer.

## Out of scope for v1

- Forking or patching the `agent-loop` core; full bidirectional live messaging
  between two arbitrary sibling sessions; realtime multi-agent UI.

## Verification

Each phase lands with unit tests plus a keyless runnable snapshot where
model/user-visible, per repository testing policy. No live profile is mutated;
no publish or tag is performed without a separate approved release plan.

Recovery: branch `docs/codex-harness-integration` from `origin/main`
(`b582515`); this change is documentation-only and performs no service restart,
profile mutation, publish, or tag.
