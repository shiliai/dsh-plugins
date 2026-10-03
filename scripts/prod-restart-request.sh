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
# Integrated wake (recommended): pass --wake-session and --wake-message-file
# and the watcher itself resumes the named session via wake-session.sh right
# after the restarted host passes its health check — no pre-armed cron and no
# guessed timestamps (both have failed in practice; the cron race killed the
# requesting turn before the job could be created). The script durably copies
# the wake message into the workflow dir and mints the wake cookie jar BEFORE
# filing the request, so the doomed host dying mid-turn loses nothing:
#
#   scripts/prod-restart-request.sh "reason…" \
#     --wake-session session-… --wake-message-file /tmp/wake.md
#
# Fire-and-forget: after the request is filed, THIS host may be replaced at
# any moment. After it comes back (the wake message is delivered
# automatically when integrated wake is used), read the outcome:
#   ~/.local/state/dsh-dev-workflow/last-result.json
#
# Usage:
#   scripts/prod-restart-request.sh [reason...] [--wake-session <id> --wake-message-file <path>]
# Cancel a pending request (before the watcher claims it):
#   rm ~/.local/state/dsh-dev-workflow/prod-restart.request.json
set -euo pipefail

DIR="${DSH_DEV_WORKFLOW_DIR:-$HOME/.local/state/dsh-dev-workflow}"
REQUEST="$DIR/prod-restart.request.json"
CLAIMED="$DIR/prod-restart.in-progress.json"
COOKIE_JAR="$DIR/prod-cookies.txt"
WAKE_MESSAGE_COPY="$DIR/wake-message.txt"
# The production host's stdout log carries the current launch token (rotates
# per restart; the cookie itself survives restarts).
PROD_STDOUT_LOG="${DSH_PROD_STDOUT_LOG:-$HOME/.local/state/dsh-remote-agent/runtime/dsh.stdout.log}"
PROD_BASE="${DSH_PROD_BASE:-http://127.0.0.1:3280}"

mkdir -p "$DIR"

REASON_ARGS=()
WAKE_SESSION_ID=""
WAKE_MESSAGE_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --wake-session) [ $# -ge 2 ] || { echo "prod-restart-request.sh: --wake-session needs a value" >&2; exit 2; }
      WAKE_SESSION_ID="$2"; shift 2 ;;
    --wake-message-file) [ $# -ge 2 ] || { echo "prod-restart-request.sh: --wake-message-file needs a value" >&2; exit 2; }
      WAKE_MESSAGE_FILE="$2"; shift 2 ;;
    --*) echo "prod-restart-request.sh: unknown option: $1" >&2; exit 2 ;;
    *) REASON_ARGS+=("$1"); shift ;;
  esac
done
if { [ -n "$WAKE_SESSION_ID" ] && [ -z "$WAKE_MESSAGE_FILE" ]; } || { [ -z "$WAKE_SESSION_ID" ] && [ -n "$WAKE_MESSAGE_FILE" ]; }; then
  echo "prod-restart-request.sh: --wake-session and --wake-message-file must be used together." >&2
  exit 2
fi
REASON="${REASON_ARGS[*]:-manual restart request}"

if [ -n "$WAKE_SESSION_ID" ]; then
  case "$WAKE_SESSION_ID" in session-*) ;; *) echo "prod-restart-request.sh: --wake-session must look like session-…" >&2; exit 2 ;; esac
  [ -f "$WAKE_MESSAGE_FILE" ] || { echo "prod-restart-request.sh: wake message file not found: $WAKE_MESSAGE_FILE" >&2; exit 2; }
  # Mint the wake cookie NOW, from the launch token in the prod stdout log —
  # after the restart the old token is gone and the doomed host cannot mint.
  TOKEN_LINE="$(grep -o 'token=[A-Za-z0-9_-]*' "$PROD_STDOUT_LOG" 2>/dev/null | tail -1 || true)"
  if [ -z "$TOKEN_LINE" ]; then
    echo "prod-restart-request.sh: no launch token found in $PROD_STDOUT_LOG; cannot mint the wake cookie." >&2
    echo "  Mint it manually (curl -s -c $COOKIE_JAR -o /dev/null \"$PROD_BASE/?token=<token>\") and re-run." >&2
    exit 1
  fi
  CODE="$(curl -s -o /dev/null -w '%{http_code}' -c "$COOKIE_JAR" "$PROD_BASE/?token=${TOKEN_LINE#token=}")"
  if [ "$CODE" != "200" ] && [ "$CODE" != "303" ]; then
    echo "prod-restart-request.sh: cookie mint against $PROD_BASE returned $CODE; aborting without filing." >&2
    exit 1
  fi
  # Durable copy of the wake message (the original may live in /tmp and the
  # requesting host is about to die; nothing here outlives the restart unless
  # it is inside $DIR).
  TMP_MSG="$DIR/wake-message.txt.tmp.$$"
  cat "$WAKE_MESSAGE_FILE" > "$TMP_MSG"
  mv "$TMP_MSG" "$WAKE_MESSAGE_COPY"
fi

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

TMP="$REQUEST.tmp.$$"
node -e '
  const [requestedBy, reason, wakeSessionId, wakeMessageFile] = process.argv.slice(1)
  const request = {
    nonce: require("node:crypto").randomUUID(),
    requestedAt: Date.now(),
    requestedBy,
    reason,
  }
  if (wakeSessionId) request.wake = { sessionId: wakeSessionId, messageFile: wakeMessageFile }
  process.stdout.write(JSON.stringify(request, null, 2) + "\n")
' "${DSH_SESSION_ID:-external}" "$REASON" "$WAKE_SESSION_ID" "$WAKE_MESSAGE_COPY" > "$TMP"
# Atomic create: a concurrent request loses the race instead of silently
# overwriting the pending one (mv would clobber).
if ! ln "$TMP" "$REQUEST" 2>/dev/null; then
  rm -f "$TMP"
  echo "prod-restart-request.sh: another request was filed concurrently; refusing." >&2
  exit 1
fi
rm -f "$TMP"

echo "prod-restart-request.sh: restart request filed ($REQUEST)."
if [ -n "$WAKE_SESSION_ID" ]; then
  echo "  Integrated wake armed: after the restart passes its health check, the"
  echo "  watcher resumes $WAKE_SESSION_ID with $WAKE_MESSAGE_COPY (cookie: $COOKIE_JAR)."
fi
echo "  The test-side watcher executes it within ~60s; this host may restart any"
echo "  moment after that. Check $DIR/last-result.json once production is back."
