#!/bin/bash
# wake-session.sh — wait for a dsh web host to come up, then inject a user
# message into one of its sessions via POST /api/session/prompt (the browser
# RPC channel). Primary use: after a production restart, let the resident dev
# host (5280) resume a session on the freshly booted host, driven by a dsh-cron
# command job — the session continues without anyone re-issuing the turn.
#
# Auth is the signed browser-session cookie, which survives a host restart
# (its HMAC secret is durable in $DSH_HOME/.credentials.yaml). Mint it BEFORE
# the restart from any terminal, using the launch token printed in the host's
# stdout log at boot:
#
#   curl -s -c <jar> -o /dev/null "http://127.0.0.1:3280/?token=<launch-token>"
#
# Usage:
#   scripts/wake-session.sh --base http://127.0.0.1:3280 \
#     --cookie-jar ~/.local/state/dsh-dev-workflow/prod-cookies.txt \
#     --session-id session-XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX \
#     --message "继续上一步:……" [--wait-seconds 1500]
#
# The prompt is admitted with mode 'queue': the RPC itself resumes the session
# on the new host and queues the message as the next turn. A turn that was in
# flight when the old host died is NOT replayed — carry the continuation
# context in --message.
#
# Exit status: 0 when the host accepted the prompt; 1 on timeout or rejection.
set -euo pipefail

BASE=""
COOKIE_JAR=""
SESSION_ID=""
MESSAGE=""
WAIT_SECONDS=1500

usage() { sed -n '2,27p' "$0"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --base) [ $# -ge 2 ] || { echo "wake-session.sh: --base needs a value" >&2; exit 2; }
      BASE="$2"; shift 2 ;;
    --cookie-jar) [ $# -ge 2 ] || { echo "wake-session.sh: --cookie-jar needs a value" >&2; exit 2; }
      COOKIE_JAR="$2"; shift 2 ;;
    --session-id) [ $# -ge 2 ] || { echo "wake-session.sh: --session-id needs a value" >&2; exit 2; }
      SESSION_ID="$2"; shift 2 ;;
    --message) [ $# -ge 2 ] || { echo "wake-session.sh: --message needs a value" >&2; exit 2; }
      MESSAGE="$2"; shift 2 ;;
    --wait-seconds) [ $# -ge 2 ] || { echo "wake-session.sh: --wait-seconds needs a value" >&2; exit 2; }
      WAIT_SECONDS="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "wake-session.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done
for required in BASE COOKIE_JAR SESSION_ID MESSAGE; do
  if [ -z "${!required}" ]; then
    echo "wake-session.sh: --$(echo "$required" | tr '_-' 'a-z-' | tr 'A-Z' 'a-z') is required" >&2
    exit 2
  fi
done
[ -f "$COOKIE_JAR" ] || { echo "wake-session.sh: cookie jar not found: $COOKIE_JAR (mint it before the restart — see header)" >&2; exit 2; }
case "$SESSION_ID" in session-*) ;; *) echo "wake-session.sh: session id must look like session-…" >&2; exit 2 ;; esac

# Wait for the host to accept HTTP at all (a restart window can be minutes).
DEADLINE=$(( $(date +%s) + WAIT_SECONDS ))
while true; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$BASE/" 2>/dev/null || echo 000)
  [ "$code" != "000" ] && break
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    echo "wake-session.sh: $BASE never came back within ${WAIT_SECONDS}s" >&2
    exit 1
  fi
  sleep 10
done
# Give plugin mounts a beat after the port opens.
sleep 8

RID="req-wake-$(date +%s)"
export RID SESSION_ID MESSAGE
body=$(python3 <<'PY'
import json, os
print(json.dumps({
    'type': 'client-request',
    'rpcId': os.environ['RID'],
    'method': 'session/prompt',
    'payload': {'args': {'request': {
        'requestId': os.environ['RID'],
        'sessionId': os.environ['SESSION_ID'],
        'mode': 'queue',
        'content': [{'type': 'text', 'text': os.environ['MESSAGE']}],
        'clientTimeZone': 'Asia/Shanghai',
    }}},
}))
PY
)

out=$(curl -s -b "$COOKIE_JAR" -m 30 -X POST "$BASE/api/session/prompt" \
  -H "Content-Type: application/json" -H "Origin: $BASE" \
  -d "$body" 2>&1)
echo "wake-session.sh: prompt response: $out"
case "$out" in *'"ok":true'*) exit 0 ;; *) exit 1 ;; esac
