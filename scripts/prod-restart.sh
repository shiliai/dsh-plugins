#!/bin/bash
# prod-restart.sh — restart the launchd-managed production dsh web host and
# verify it came back healthy. This is the only sanctioned way to restart
# production: launchd guarantees the single-writer ordering (old process fully
# stopped and its port released before the replacement starts), which manual
# restarts have failed to do (see AGENTS.md "DSH restart safety").
#
# CRITICAL: run this from a session that is NOT hosted by the production host
# (e.g. a dev-sandbox session on :5280) or from an external terminal. A tool
# call issued inside the host being replaced never gets its result persisted.
#
# Usage:
#   DSH_WEB_SERVICE_LABEL=<label> scripts/prod-restart.sh
# The label is the launchd service that owns the production port - check with
#   launchctl list | grep -i dsh
# (on the reference machine the existing service is io.shiliai.dsh-remote-mac;
# do NOT create a second service from the plist template while it exists).
#
# Optional env:
#   DSH_WEB_PORT        production port                 (default 3280)
#   DSH_WEB_STDOUT_LOG  launchd StandardOutPath log     (default
#                       ~/.local/state/dsh-remote-agent/runtime/dsh.stdout.log)
#   WECOM_WEBHOOK_URL   if set, POST a markdown restart notice to this webhook
#   NOTIFY_MESSAGE      extra line appended to the notice
set -euo pipefail

LABEL="${DSH_WEB_SERVICE_LABEL:?set DSH_WEB_SERVICE_LABEL to the launchd label that owns the production port}"
PORT="${DSH_WEB_PORT:-3280}"
STDOUT_LOG="${DSH_WEB_STDOUT_LOG:-$HOME/.local/state/dsh-remote-agent/runtime/dsh.stdout.log}"
UID_N="$(id -u)"

service_pid() {
  launchctl print "gui/$UID_N/$LABEL" 2>/dev/null | awk '$1 == "pid" && $2 == "=" {print $3; exit}'
}
listener_pid() {
  lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true
}

echo "prod-restart.sh: preflight - service '$LABEL', port $PORT"
launchctl print "gui/$UID_N/$LABEL" >/dev/null 2>&1 || {
  echo "prod-restart.sh: launchd service '$LABEL' is not loaded." >&2
  echo "  Find the service that owns port $PORT (launchctl list | grep -i dsh)" >&2
  echo "  and pass it via DSH_WEB_SERVICE_LABEL. Only if NONE exists, install" >&2
  echo "  one from scripts/dsh-web.plist.template (see its header)." >&2
  exit 1
}

SPID="$(service_pid || true)"
CUR_PID="$(listener_pid)"
if [ -n "$CUR_PID" ]; then
  if [ "$CUR_PID" != "$SPID" ]; then
    echo "prod-restart.sh: REFUSING to restart." >&2
    echo "  Port $PORT is owned by pid $CUR_PID, which is NOT the launchd service" >&2
    echo "  '$LABEL' (pid ${SPID:-<none>}). kickstart -k would not stop it, and a" >&2
    echo "  crash-looping replacement could double-write the session journal." >&2
    echo "  Kill the stray process from an external terminal, confirm the port is" >&2
    echo "  free, then re-run this script." >&2
    exit 1
  fi
  echo "prod-restart.sh: port $PORT is owned by service pid $SPID (as expected)."
else
  echo "prod-restart.sh: nothing is listening on $PORT; service will start fresh."
fi

echo "prod-restart.sh: kickstart -k (launchd stops the old process and waits for"
echo "its port before starting the replacement - the single-writer guarantee)."
launchctl kickstart -k "gui/$UID_N/$LABEL"

# Wait for the old listener (if any) to release the port first.
if [ -n "$CUR_PID" ]; then
  for _ in $(seq 1 30); do
    [ "$(listener_pid)" != "$CUR_PID" ] && break
    sleep 1
  done
  if [ "$(listener_pid)" = "$CUR_PID" ]; then
    echo "prod-restart.sh: old pid $CUR_PID still holds $PORT after 30s; aborting." >&2
    exit 1
  fi
fi

UP=0
for _ in $(seq 1 120); do
  if curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then UP=1; break; fi
  sleep 1
done
if [ "$UP" != 1 ]; then
  echo "prod-restart.sh: production did not answer on 127.0.0.1:$PORT within ~120s." >&2
  echo "  Check: launchctl print gui/$UID_N/$LABEL ; tail -50 '$STDOUT_LOG'" >&2
  exit 1
fi

# The healthy listener must be OUR service, not a straggler that grabbed the port.
NEW_PID="$(listener_pid)"
NEW_SPID="$(service_pid || true)"
if [ -z "$NEW_PID" ] || [ "$NEW_PID" != "$NEW_SPID" ]; then
  echo "prod-restart.sh: post-check FAILED - port $PORT is answered by pid ${NEW_PID:-<none>}," >&2
  echo "  but service '$LABEL' reports pid ${NEW_SPID:-<none>}. Another process is" >&2
  echo "  squatting the port; investigate before trusting this 'healthy' signal." >&2
  exit 1
fi

TOKEN_URL="$(grep -o "http://127\.0\.0\.1:$PORT/?token=[A-Za-z0-9_-]*" "$STDOUT_LOG" 2>/dev/null | tail -1 || true)"
echo "prod-restart.sh: production is back on 127.0.0.1:$PORT (service pid $NEW_SPID)."
echo "  UI: ${TOKEN_URL:-<see $STDOUT_LOG for the token URL>}"

NOTICE="DSH web production restarted and healthy on :$PORT."
[ -n "${NOTIFY_MESSAGE:-}" ] && NOTICE="$NOTICE
$NOTIFY_MESSAGE"
[ -n "$TOKEN_URL" ] && NOTICE="$NOTICE
$TOKEN_URL"

if [ -n "${WECOM_WEBHOOK_URL:-}" ]; then
  curl -sf -m 10 -X POST "$WECOM_WEBHOOK_URL" \
    -H 'Content-Type: application/json' \
    -d "$(node -e 'console.log(JSON.stringify({msgtype:"markdown",markdown:{content:process.argv[1]}}))' "$NOTICE")" \
    >/dev/null && echo "prod-restart.sh: notice posted to WeCom webhook." \
    || echo "prod-restart.sh: warning - WeCom webhook post failed." >&2
fi

echo "prod-restart.sh: done. Sessions survive on disk; in-flight turns on the old"
echo "host were interrupted and need to be re-issued after resume."
