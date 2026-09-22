# @dsh-plugins/dsh-config-portability

Shared, source-inlined contract for DSH plugin **config export / import** (the unified「配置迁移」entry). Private package: consumers bundle it from workspace source via tsdown `alias` + tsconfig `paths` (same pattern as `dsh-reading-core`) — never as a git-hosted subdependency.

- `src/contracts.ts` — envelope format (`dsh-config-export`, format version 1), `buildEnvelope` / `mergeEnvelopes` / `parseEnvelope` (strict validation, rejects newer versions).
- `src/provider.ts` — the `ConfigPortabilityProvider` contract (`exportConfig({redactSecrets})` / `importConfig(config, {dryRun})`).
- `src/server.ts` — `handleConfigPortabilityRoute(...)`: convention HTTP endpoints, duck-typed (no `node:http` import, bundle-safe).
- `src/client.tsx` — `window.__DSH_CONFIG_PORTABILITY__` registry, export/import helpers, and the ready-made React settings tab (`mountConfigPortabilityTab`).

## Envelope

```json
{
  "kind": "dsh-config-export",
  "formatVersion": 1,
  "exportedAt": "2026-09-21T00:00:00.000Z",
  "plugins": {
    "dsh-reading": { "displayName": "Reading", "config": { "…": "plugin-defined" } }
  }
}
```

Multi-plugin exports merge the `plugins` maps (later wins, earliest `exportedAt` kept); a single-plugin export is the same structure with one key.

## Convention endpoints (per plugin, under its own API prefix)

| Endpoint | Method | Behavior |
| --- | --- | --- |
| `/config/export?redact=1` | GET | Envelope with this plugin's section. `redact=1` blanks credential fields. |
| `/config/import?dryRun=1` | POST | Validate + report without persisting. |
| `/config/import` | POST | Apply the envelope's section for this plugin; respond `{ ok, dryRun, report }`. |

The shared handler enforces the same-origin policy on POST (missing `Origin` stays allowed for native clients) and returns structured errors as `{ error, code, status }` (`ConfigPortabilityError`).

## Joining with two steps (e.g. dsh-wecom, dsh-cron)

**1. Server side** — implement the provider and hand it to the shared handler inside your router:

```ts
import { handleConfigPortabilityRoute, type ConfigPortabilityProvider } from '@dsh-plugins/dsh-config-portability'

const provider: ConfigPortabilityProvider = {
  id: 'dsh-wecom',
  displayName: 'WeCom',
  exportConfig: ({ redactSecrets }) => redactSecrets ? { ...config, secret: '' } : { ...config },
  importConfig: (config, { dryRun }) => applyConfig(config, { dryRun }), // → { applied, skipped, warnings }
}

// inside your prefix router, before other routes:
if (await handleConfigPortabilityRoute(request, response, endpoint, provider, { query: url.searchParams })) return
```

**2. Client side** — register the API prefix (and mount the shared tab once):

```ts
import { registerPortabilityProvider, mountConfigPortabilityTab } from '@dsh-plugins/dsh-config-portability/client'

registerPortabilityProvider({ id: 'dsh-wecom', displayName: 'WeCom', apiPrefix: '/dsh-wecom/api' })
mountConfigPortabilityTab(ctx) // deduplicated per window; mounts the「配置迁移」settings tab
```

That is the entire integration: the shared tab discovers every registered plugin via `window.__DSH_CONFIG_PORTABILITY__`, exports them into one merged envelope file, and imports envelope files with a dry-run preview. Joining plugins write no UI of their own.

## Import semantics to honor in your provider

- Credential fields left empty (e.g. a redacted export) → **skip** the section and add a warning; never persist partial credentials.
- Invalid URLs/values → reject the whole import (throw `ConfigPortabilityError`); leave no residue.
- Reference-only fields (machine-specific paths) → warn on mismatch, never apply.
- Dry-run must not mutate any state.

## Development

```sh
pnpm --filter @dsh-plugins/dsh-config-portability check   # typecheck + test
```
