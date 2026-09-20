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
#   DSH_WEB_SERVICE_LABEL=com.shiliai.dsh-web scripts/prod-restart.sh
#
# Optional env:
#   DSH_WEB_PORT        production port                 (default 3280)
#   DSH_WEB_STDOUT_LOG  launchd StandardOutPath log     (default
#                       ~/.local/state/dsh-remote-agent/runtime/dsh.stdout.log)
#   WECOM_WEBHOOK_URL   if set, POST a markdown restart notice to this webhook
#   NOTIFY_MESSAGE      extra line appended to the notice
set -euo pipefail

LABEL="${DSH_WEB_SERVICE_LABEL:?set DSH_WEB_SERVICE_LABEL to the launchd label (see scripts/dsh-web.plist.template)}"
PORT="${DSH_WEB_PORT:-3280}"
STDOUT_LOG="${DSH_WEB_STDOUT_LOG:-$HOME/.local/state/dsh-remote-agent/runtime/dsh.stdout.log}"
UID_N="$(id -u)"

echo "prod-restart.sh: preflight — service '$LABEL', port $PORT"
launchctl print "gui/$UID_N/$LABEL" >/dev/null 2>&1 || {
  echo "prod-restart.sh: launchd service '$LABEL' is not loaded." >&2
  echo "  Install it once (see scripts/dsh-web.plist.template), e.g.:" >&2
  echo "    sed -e 's|__HOME__|$HOME|g' -e 's|__PORT__|$PORT|g' \\" >&2
  echo "        scripts/dsh-web.plist.template > ~/Library/LaunchAgents/$LABEL.plist" >&2
  echo "    sed -i '' \"s|__BIN__|\$(ls -d \$HOME/.local/share/dsh-cli/releases/*/node_modules/.pnpm/@deepseek-ai+dsh@*/node_modules/@deepseek-ai/dsh/lib/bin.js | sort -V | tail -1)|\" ~/Library/LaunchAgents/$LABEL.plist" >&2
  echo "    launchctl bootstrap gui/$UID_N ~/Library/LaunchAgents/$LABEL.plist" >&2
  exit 1
}
if ! lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "prod-restart.sh: warning — nothing is listening on $PORT; starting the service."
fi

echo "prod-restart.sh: kickstart -k (launchd stops the old process and waits for"
echo "its port before starting the replacement — the single-writer guarantee)."
launchctl kickstart -k "gui/$UID_N/$LABEL"

UP=0
for _ in $(seq 1 120); do
  if curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then UP=1; break; fi
  sleep 1
done
if [ "$UP" != 1 ]; then
  echo "prod-restart.sh: production did not answer on 127.0.0.1:$PORT within 120s." >&2
  echo "  Check: launchctl print gui/$UID_N/$LABEL ; tail -50 '$STDOUT_LOG'" >&2
  exit 1
fi

TOKEN_URL="$(grep -o "http://127\.0\.0\.1:$PORT/?token=[A-Za-z0-9_-]*" "$STDOUT_LOG" 2>/dev/null | tail -1 || true)"
echo "prod-restart.sh: production is back on 127.0.0.1:$PORT."
echo "  UI: ${TOKEN_URL:-<see $STDOUT_LOG for the token URL>}"

NOTICE="DSH web 生产实例已重启并通过健康检查(:$PORT)。"
[ -n "${NOTIFY_MESSAGE:-}" ] && NOTICE="$NOTICE
$NOTIFY_MESSAGE"
[ -n "$TOKEN_URL" ] && NOTICE="$NOTICE
$TOKEN_URL"

if [ -n "${WECOM_WEBHOOK_URL:-}" ]; then
  curl -s -m 10 -X POST "$WECOM_WEBHOOK_URL" \
    -H 'Content-Type: application/json' \
    -d "$(node -e 'console.log(JSON.stringify({msgtype:"markdown",markdown:{content:process.argv[1]}}))' "$NOTICE")" \
    >/dev/null && echo "prod-restart.sh: notice posted to WeCom webhook." \
    || echo "prod-restart.sh: warning — WeCom webhook post failed." >&2
fi

echo "prod-restart.sh: done. Sessions survive on disk; in-flight turns on the old"
echo "host were interrupted and need to be re-issued after resume."
