#!/bin/bash
# prod-restart-request.sh — ask the test environment to restart production.
#
# Safe to run INSIDE a production session: the script only writes a request
# file and exits. Writing the file is durable before the tool call ends, so
# the result persists even though the production host is about to be replaced
# (unlike running prod-restart.sh from the doomed host, whose tool result
# would be lost - see AGENTS.md "DSH restart safety").
#
# The watcher on the test side (io.shiliai.dsh-dev-restart-watch, installed by
# scripts/dev-service.sh install) polls the workflow dir every 60s and
# executes prod-restart.sh with its full guard set.
#
# Fire-and-forget: after the request is filed, THIS host may be replaced at
# any moment. After it comes back, read the outcome:
#   ~/.local/state/dsh-dev-workflow/last-result.json
#
# Usage:
#   scripts/prod-restart-request.sh [reason...]
# Cancel a pending request (before the watcher claims it):
#   rm ~/.local/state/dsh-dev-workflow/prod-restart.request.json
set -euo pipefail

DIR="${DSH_DEV_WORKFLOW_DIR:-$HOME/.local/state/dsh-dev-workflow}"
REQUEST="$DIR/prod-restart.request.json"
CLAIMED="$DIR/prod-restart.in-progress.json"

mkdir -p "$DIR"
if [ -f "$REQUEST" ] || [ -f "$CLAIMED" ]; then
  echo "prod-restart-request.sh: a restart request is already pending or running." >&2
  if [ -f "$REQUEST" ]; then
    echo "  Pending (not yet claimed): remove $REQUEST to cancel." >&2
  else
    echo "  In progress (claimed by the watcher): it cannot be cancelled." >&2
    echo "  If the watcher died mid-run, the stale claim is reclaimed as" >&2
    echo "  'abandoned' after ~6 minutes — see $DIR/last-result.json." >&2
  fi
  exit 1
fi

REASON="${*:-manual restart request}"
TMP="$REQUEST.tmp.$$"
node -e '
  const [requestedBy, reason] = process.argv.slice(1)
  process.stdout.write(JSON.stringify({
    nonce: require("node:crypto").randomUUID(),
    requestedAt: Date.now(),
    requestedBy,
    reason,
  }, null, 2) + "\n")
' "${DSH_SESSION_ID:-external}" "$REASON" > "$TMP"
# Atomic create: a concurrent request loses the race instead of silently
# overwriting the pending one (mv would clobber).
if ! ln "$TMP" "$REQUEST" 2>/dev/null; then
  rm -f "$TMP"
  echo "prod-restart-request.sh: another request was filed concurrently; refusing." >&2
  exit 1
fi
rm -f "$TMP"

echo "prod-restart-request.sh: restart request filed ($REQUEST)."
echo "  The test-side watcher executes it within ~60s; this host may restart any"
echo "  moment after that. Check $DIR/last-result.json once production is back."
