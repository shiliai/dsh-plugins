#!/bin/bash
# prod-restart-watch.sh — consume a pending production-restart request.
#
# Runs on the TEST side, every 60s via the launchd watcher
# io.shiliai.dsh-dev-restart-watch (installed by scripts/dev-service.sh
# install). Exits 0 quietly when nothing is pending so launchd logs stay
# clean. When a request appears it is claimed atomically, TTL-checked, and
# executed through prod-restart.sh — which carries the full guard set
# (port-ownership check, kickstart -k single-writer ordering, post-check).
#
# NEVER run this on the production host itself: it replaces the production
# process, and a result computed on the doomed host has nowhere to persist.
# The guard below refuses to run when the ambient DSH_HOME is the production
# home.
set -euo pipefail

DIR="${DSH_DEV_WORKFLOW_DIR:-$HOME/.local/state/dsh-dev-workflow}"
REQUEST="$DIR/prod-restart.request.json"
CLAIMED="$DIR/prod-restart.in-progress.json"
RESULT="$DIR/last-result.json"
LOG_DIR="$HOME/.local/state/dsh-dev"
TTL_MS="${DSH_PROD_RESTART_TTL_MS:-600000}"
LABEL="${DSH_WEB_SERVICE_LABEL:-io.shiliai.dsh-remote-mac}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

[ -f "$REQUEST" ] || exit 0

# Refuse to act from the production host: the watcher must live on the test
# side. (Inside a dsh session DSH_HOME is exported; under launchd it is unset,
# which is fine.)
PROD_HOME="$(python3 -c 'import os; print(os.path.realpath(os.path.expanduser("~/.local/dsh_home")))')"
if [ -n "${DSH_HOME:-}" ] && [ "$(python3 -c 'import os,sys; print(os.path.realpath(os.path.expanduser(sys.argv[1])))' "$DSH_HOME")" = "$PROD_HOME" ]; then
  echo "prod-restart-watch.sh: refusing to run from the production home ($DSH_HOME)." >&2
  exit 1
fi

# Claim atomically; a second watcher tick sees no request and exits.
mv "$REQUEST" "$CLAIMED"

finish() {  # status message
  local status="$1" message="$2"
  node -e '
    const [file, claimed, status, message] = process.argv.slice(1)
    const fs = require("fs")
    let req = {}
    try { req = JSON.parse(fs.readFileSync(claimed, "utf8")) } catch {}
    fs.writeFileSync(file, JSON.stringify({
      nonce: req.nonce ?? null,
      requestedAt: req.requestedAt ?? null,
      reason: req.reason ?? null,
      status,
      message,
      finishedAt: Date.now(),
    }, null, 2) + "\n")
    fs.rmSync(claimed, { force: true })
  ' "$RESULT" "$CLAIMED" "$status" "$message"
  [ "$status" = ok ] && exit 0 || exit 1
}

# Expired requests are dropped: a stale request replayed after an unrelated
# boot would restart production for no live reason.
REQ_AGE_MS="$(node -e '
  const fs = require("fs")
  try {
    const req = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    process.stdout.write(String(Date.now() - Number(req.requestedAt || 0)))
  } catch { process.stdout.write("Infinity") }
' "$CLAIMED")"
if [ "$REQ_AGE_MS" = "Infinity" ] || [ "$REQ_AGE_MS" -gt "$TTL_MS" ] 2>/dev/null; then
  finish expired "request older than ${TTL_MS}ms; dropped"
fi

mkdir -p "$LOG_DIR"
RUN_LOG="$LOG_DIR/prod-restart-$(date +%Y%m%d-%H%M%S).log"
echo "prod-restart-watch.sh: executing restart request (log: $RUN_LOG)"
if DSH_WEB_SERVICE_LABEL="$LABEL" "$REPO_ROOT/scripts/prod-restart.sh" >"$RUN_LOG" 2>&1; then
  finish ok "production restarted; log: $RUN_LOG"
else
  finish failed "prod-restart.sh exited $?, log: $RUN_LOG"
fi
