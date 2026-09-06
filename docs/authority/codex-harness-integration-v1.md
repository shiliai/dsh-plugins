# Codex Harness Integration Baseline

Baseline revision: `codex-harness-integration-v1`

## Approval

Tracking PR in the 2026-08-23 task. The maintainer asked to record the Codex
Harness research and the no-fork, plugin-based plan for bringing the four
capabilities — multi-agent session communication and viewing, scheduling of
independent/current sessions, per-agent model + reasoning effort, and
cross-session memory — into DSH through this repository.

Source of truth for the research:
`/Users/chris/project/codex-harness-notes.md`,
`/Users/chris/project/dsh-codex-integration-notes.md`, and the cloned codex
source at `/Users/chris/project/codex-harness-src`.

## Required stories

### CH-01

As a DSH user, I want a subagent to be able to run with a different reasoning
effort (and where applicable a different model) than the parent, so that I can
orchestrate heterogeneous agent roles.

- Given a coordinator agent that spawns a child with a requested effort
- When the child turn runs
- Then the child's request config carries that `reasoningEffort`, forwarded to
  the DSH model layer (and to a Codex harness child via `subagent-codex` where
  used)

### CH-02

As a DSH user, I want to view and resume other sessions, including sessions on a
remote host, so that I can inspect and drive work outside the current agent.

- Given a DSH host that can attach to a remote runtime session
- When I list or resume that session
- Then DSH renders its read-only snapshot and can submit new input to it

### CH-03

As a DSH user, I want cross-session memory so that knowledge from earlier
sessions is recalled in later ones.

- Given stored memory keyed by workspace/session
- When a later session asks
- Then DSH injects a read-only recall of relevant memory into the model context

## Out of scope

- Forking or patching the `agent-loop` core; full bidirectional live messaging
  between two arbitrary sibling sessions; realtime multi-agent UI.

## Verification

Each phase lands with unit tests plus a keyless runnable snapshot where
model/user-visible, per repository testing policy. No live profile is mutated;
no publish or tag is performed without a separate approved release plan.

Recovery: branch `docs/codex-harness-integration` from `origin/main`
(`b582515`); this change is documentation-only and performs no service restart,
profile mutation, publish, or tag.
