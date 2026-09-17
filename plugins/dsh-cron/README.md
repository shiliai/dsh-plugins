# dsh-cron

Host-side unattended scheduler for [DeepSeek Harness](https://github.com/shiliai/dsh-plugins) (DSH).
Jobs are **trigger + task + policy + optional delivery**, live outside any
interactive session, and fire while the DSH process is alive. Complements the
built-in `@deepseek-ai/dsh-schedule` (in-session persistent reminders).
Design: `docs/plans/dsh-cron-v1.md`.

## Install

```bash
dsh plugin --profile web add \
  'github:shiliai/dsh-plugins#path:/plugins/dsh-cron'
```

Upgrades go through the repository updater (never plain `pnpm outdated`, which
cannot see new commits behind a Git source):

```bash
dsh plugin --profile web --config.dlx-cache-max-age=0 dlx \
  'github:shiliai/dsh-plugins#path:/scripts/dsh-plugin-updater' check
```

## What it does

- **Triggers** (exactly one): `cron` (5-field expression + **explicit IANA
  `timeZone`**, never the process zone), `everySeconds` (anchor-aligned,
  ≥ 60 s), `at` (one-shot RFC 3339 with Z or numeric offset).
- **Tasks**: `agent` — a one-shot disposable agent created through
  `ctx.agents.create`, prompt submitted with a `[CRON RUN]` unattended framing,
  last assistant message becomes the run summary, then the agent is disposed;
  or `command` — a subprocess with exit code and bounded output tail.
- **Reliability**: at-most-once (`lastFiredMs` is durable before execution),
  misfire `skip | runOnce`, overlap `skip | queue(1) | replace`, crash repair
  (`running` → `aborted` on boot), clock discipline (the tick loop re-reads the
  wall clock on every wake), and a mandatory validity window for loops
  (`endAt` or `maxDurationSeconds`, ≤ 1 year) — infinite cron is rejected.
- **Runs**: every fire produces a durable run record (`<job>#<seq>`), kept per
  job up to `historyLimit` (default 50). Agent runs persist as real DSH
  sessions (`session-<uuid>`); clicking one in the Web panel opens the native
  session replay.

## Web panel

Sidebar footer「定时任务」button opens an overlay panel: job list with status
dots, next-fire countdowns, live elapsed timers, expandable run history, and a
single-screen create/edit modal (trigger presets + custom layer, agent preset /
pinned model / permission preset — all optional and inheriting the host
default, with reasoning-effort options sourced from the model's provider
catalog).

## Model tools & skill

`cron_create`, `cron_list`, `cron_runs`, `cron_run_now`, `cron_enable`,
`cron_disable`, `cron_delete` are registered for every runtime agent, plus a
`cron-create` skill (collect → confirm → create → verify). Only `manual` jobs
can be created or deleted through tools; other sources are runnable, pausable,
and viewable. Tool results always echo absolute ISO times — the model never
does time math.

## Delivery (v1.0: command)

Configure `delivery: { kind: 'command', argv: [...], onFailureOnly?: true }`
on a job (via the API or a tool-created job spec) and the run record JSON is
piped to that process's stdin after each run — on failures only by default.

## Configuration (`cron` namespace, cordis patch)

| Key | Default | Meaning |
| --- | --- | --- |
| `historyLimit` | 50 | Run records kept per job |
| `tickIntervalMs` | 15000 | Scheduler tick period (≥ 1000) |
| `maxConcurrentRuns` | 0 | Global concurrent-run cap; 0 = unlimited |

`sessionGc` is accepted but **inert in v1.0**: automatic deletion of persisted
session journals is destructive, so cron run sessions are retained until the
v1.2 GC panel ships.

## Persistence

State lives in the `cron` storage domain (`$DSH_HOME/storages/cron.json` with
the default json backend) — never in the session journal. Uninstalling the
plugin keeps the data; reinstalling rehydrates it. To wipe everything:

```bash
rm "$DSH_HOME"/storages/cron.json
```

## Notes & limits

- Jobs fire only while the DSH process is alive (no system crontab bridge).
- The Web API mutates only with `application/json` same-origin requests.
- v1.0 ships the manual job source; declarative `config.jobs`, the
  `ctx.cron.registerJob` plugin service, callback tasks, and a native WeCom
  delivery channel are staged for v1.1 (see the design doc's roadmap).
