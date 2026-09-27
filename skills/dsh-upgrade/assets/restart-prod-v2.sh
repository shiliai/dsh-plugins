#!/bin/bash
# restart-prod.sh — deploy the staged dsh 0.1.7-rc.2 to the global install,
# restart the production dsh web host on :3080, and wake its session.
#
# CRITICAL: run this ONLY from a host that is NOT the production host
# (e.g. the debug dsh web instance on :5280). A tool call issued inside the
# production host would lose its result when the host is replaced
# (see ShiLi/dsh-plugins AGENTS.md "DSH restart safety").
#
# Sequence (single-writer safe):
#   1. grace sleep — let the production host flush the orchestrating turn
#   2. backup the old install (APFS clone, while everything is stable)
#   3. TERM the production host, wait until the process is gone AND :3080 is free
#   4. npm install -g @deepseek-ai/dsh@0.1.7-rc.2  (rollback: rsync from backup)
#   5. update dsh-better-sidebar to 0.21.1 in the production profile
#   6. start the new production host detached (log + launch token in the log)
#   7. wait for health, mint the browser cookie from the fresh launch token
#   8. wake the orchestrating session via POST /api/session/prompt (mode queue)
# On health failure: roll back the install + plugin and restart the old build.
set -uo pipefail

STATE=/Users/chris/.local/state/dsh-update
LOG="$STATE/restart.log"
PROD_LOG="$STATE/prod-web.log"
COOKIES="$STATE/prod-cookies.txt"
BACKUP=/Users/chris/Project/dsh-backup-0.1.5-rc.2
GLOBAL_DIR=/opt/homebrew/lib/node_modules/@deepseek-ai/dsh
PROD_PORT=3080
PROD_CWD=/Users/chris
NEW_VERSION=0.1.7-rc.2
PROD_HOME=/Users/chris/.dsh
SESSION_ID=session-76fd5db3-62bf-4f79-b18b-0329f9ba11d6

mkdir -p "$STATE" || { echo "cannot create $STATE" >&2; exit 1; }
log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

# Defined before any use: the preflight branch exits before the later
# definitions would execute (bash defines functions in execution order).
listener_pid() { lsof -tiTCP:"$PROD_PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true; }

# Preflight mode: verify every privileged prerequisite WITHOUT touching
# production. 2026-09-24 incident lesson: never discover a sandbox write
# denial after the production host is already dead.
if [ "${DSH_RESTART_PREFLIGHT:-}" = "1" ]; then
  echo "== preflight =="
  touch "$STATE/.probe" && rm -f "$STATE/.probe" && echo "OK: state dir writable ($STATE)" || { echo "FAIL: $STATE not writable"; exit 1; }
  touch "$GLOBAL_DIR/.probe" 2>/dev/null && rm -f "$GLOBAL_DIR/.probe" && echo "OK: global install writable ($GLOBAL_DIR)" || { echo "FAIL: $GLOBAL_DIR not writable (sandbox?)"; exit 1; }
  [ -w "$PROD_HOME/profiles/web" ] && echo "OK: prod profile writable" || { echo "FAIL: $PROD_HOME/profiles/web not writable"; exit 1; }
  touch "$PROD_HOME/.probe" 2>/dev/null && rm -f "$PROD_HOME/.probe" && echo "OK: prod home writable" || { echo "FAIL: $PROD_HOME not writable"; exit 1; }
  npm ping >/dev/null 2>&1 && echo "OK: npm registry reachable" || echo "WARN: npm ping failed (install may need network)"
  kill -0 "$(listener_pid)" 2>/dev/null && echo "OK: can signal production pid $(listener_pid)" || { echo "FAIL: cannot signal production pid"; exit 1; }
  echo "PREFLIGHT OK"
  exit 0
fi

# GO-guard: refuse to run unless explicitly armed. A stale pending approval
# (see the 2026-09-24 incident) must never be able to re-trigger a restart.
if [ "${DSH_RESTART_GO:-}" != "1" ]; then
  echo "restart-prod-v2.sh: not armed (set DSH_RESTART_GO=1 to run); nothing done." >&2
  exit 0
fi

# Hard preconditions BEFORE anything destructive.
touch "$GLOBAL_DIR/.probe" 2>/dev/null && rm -f "$GLOBAL_DIR/.probe" \
  || { log "FATAL: $GLOBAL_DIR not writable — refusing to stop production"; exit 1; }
touch "$STATE/.probe" && rm -f "$STATE/.probe" \
  || { log "FATAL: $STATE not writable — refusing to stop production"; exit 1; }


log "=== restart-prod.sh start (pid $$, ppid $PPID) ==="

# 1. Grace: the production host may still be flushing the orchestrating turn.
log "grace sleep 25s before touching production (journal flush window)"
sleep 25

# 2. Backup old install while stable.
if [ ! -d "$BACKUP" ]; then
  log "backup $GLOBAL_DIR -> $BACKUP"
  cp -Rc "$GLOBAL_DIR" "$BACKUP" 2>/dev/null || cp -R "$GLOBAL_DIR" "$BACKUP" || { log "FATAL: backup failed"; exit 1; }
else
  log "backup already exists: $BACKUP"
fi

OLD_PID="$(listener_pid)"
log "production listener pid: ${OLD_PID:-<none>}"

# 3. Stop the production host; the port must be released before anything starts.
if [ -n "$OLD_PID" ]; then
  log "sending TERM to production pid $OLD_PID"
  kill -TERM "$OLD_PID"
  for _ in $(seq 1 30); do
    [ -z "$(listener_pid)" ] && ! kill -0 "$OLD_PID" 2>/dev/null && break
    sleep 1
  done
  if [ -n "$(listener_pid)" ] || kill -0 "$OLD_PID" 2>/dev/null; then
    log "production pid $OLD_PID still alive after 30s of TERM; sending KILL"
    kill -KILL "$OLD_PID" 2>/dev/null
    for _ in $(seq 1 15); do
      [ -z "$(listener_pid)" ] && ! kill -0 "$OLD_PID" 2>/dev/null && break
      sleep 1
    done
  fi
  if [ -n "$(listener_pid)" ] || kill -0 "$OLD_PID" 2>/dev/null; then
    log "FATAL: production pid $OLD_PID would not die; aborting (nothing was replaced)"
    exit 1
  fi
  log "production host stopped; port $PROD_PORT free"
else
  log "nothing listening on $PROD_PORT; will start fresh"
fi

# 4. Deploy the new version globally (npm owns the tree; other globals untouched).
log "npm install -g @deepseek-ai/dsh@$NEW_VERSION"
if ! npm install -g "@deepseek-ai/dsh@$NEW_VERSION" --no-audit --no-fund >> "$LOG" 2>&1; then
  log "ERROR: npm install failed; rolling back"
  rsync -a --delete "$BACKUP/" "$GLOBAL_DIR/"
  log "rollback done; restarting old build"
fi
DEPLOYED="$(/opt/homebrew/bin/dsh --version 2>&1)"
log "deployed dsh --version: $DEPLOYED"
if [ "$DEPLOYED" != "$NEW_VERSION" ]; then
  log "FATAL: deployed version is '$DEPLOYED', expected $NEW_VERSION"
  exit 1
fi

# 5. Update the sidebar plugin in the production profile (peer peers want ^0.1.7).
log "updating dsh-better-sidebar to 0.21.1 in production profile"
if ( cd "$PROD_HOME/profiles/web" \
      && PATH="/opt/homebrew/bin:$PATH" DSH_HOME="$PROD_HOME" \
         /opt/homebrew/bin/dsh plugin --profile web add dsh-better-sidebar@0.21.1 ) >> "$LOG" 2>&1; then
  log "plugin updated to 0.21.1"
else
  log "WARNING: plugin update failed; production will boot with the old plugin version"
fi

# 6. Start the new production host, detached (survives this script's parent).
rm -f "$PROD_LOG"
log "starting new production host (cwd $PROD_CWD, port $PROD_PORT)"
python3 - "$PROD_LOG" "$PROD_CWD" <<'PY'
import os, sys
log_path, cwd = sys.argv[1], sys.argv[2]
pid = os.fork()
if pid == 0:
    os.setsid()
    if os.fork() == 0:
        os.chdir(cwd)
        log = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
        os.dup2(log, 1); os.dup2(log, 2)
        os.dup2(os.open(os.devnull, os.O_RDONLY), 0)
        os.execve("/opt/homebrew/bin/node",
                  ["node", "/opt/homebrew/bin/dsh", "web", "--port", "3080", "--no-open"],
                  {"HOME": os.environ["HOME"], "PATH": os.environ.get("PATH", "/usr/bin:/bin:/opt/homebrew/bin")})
    os._exit(0)
os.waitpid(pid, 0)
PY

# 7. Health wait.
NEW_PID=""
for _ in $(seq 1 60); do
  sleep 2
  P="$(listener_pid)"
  if [ -n "$P" ]; then
    CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:$PROD_PORT/" 2>/dev/null || echo 000)
    if [ "$CODE" != "000" ]; then NEW_PID="$P"; break; fi
  fi
done
if [ -z "$NEW_PID" ]; then
  log "FATAL: new production host never came up; rolling back"
  P="$(listener_pid)"; [ -n "$P" ] && kill -KILL "$P" 2>/dev/null
  sleep 2
  rsync -a --delete "$BACKUP/" "$GLOBAL_DIR/"
  ( cd "$PROD_HOME/profiles/web" \
      && PATH="/opt/homebrew/bin:$PATH" DSH_HOME="$PROD_HOME" \
         /opt/homebrew/bin/dsh plugin --profile web add dsh-better-sidebar@0.19.1 ) >> "$LOG" 2>&1
  log "rollback complete; restarting old build"
  python3 - "$PROD_LOG" "$PROD_CWD" <<'PY'
import os, sys
log_path, cwd = sys.argv[1], sys.argv[2]
pid = os.fork()
if pid == 0:
    os.setsid()
    if os.fork() == 0:
        os.chdir(cwd)
        log = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
        os.dup2(log, 1); os.dup2(log, 2)
        os.dup2(os.open(os.devnull, os.O_RDONLY), 0)
        os.execve("/opt/homebrew/bin/node",
                  ["node", "/opt/homebrew/bin/dsh", "web", "--port", "3080", "--no-open"],
                  {"HOME": os.environ["HOME"], "PATH": os.environ.get("PATH", "/usr/bin:/bin:/opt/homebrew/bin")})
    os._exit(0)
os.waitpid(pid, 0)
PY
  exit 1
fi
log "new production host healthy: pid $NEW_PID on :$PROD_PORT (HTTP $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PROD_PORT/))"
sleep 3

# 8. Mint the browser cookie from the fresh launch token, then wake the session.
TOKEN="$(grep -o 'token=[A-Za-z0-9_-]*' "$PROD_LOG" | head -1 | cut -d= -f2)"
if [ -z "$TOKEN" ]; then
  log "ERROR: no launch token found in $PROD_LOG; cannot wake the session automatically"
  exit 1
fi
curl -s -c "$COOKIES" -o /dev/null -w "cookie mint: %{http_code}\n" "http://127.0.0.1:$PROD_PORT/?token=$TOKEN" >> "$LOG" 2>&1
sleep 8

# bash 3.2 has no heredocs inside $( ); build the body in a top-level heredoc.
cat > "$STATE/wake-message.txt" <<'MSG'
生产环境 dsh 已由调试实例(:5280)完成重启，请验证并汇报：
1) 运行 `dsh --version`，应为 0.1.7-rc.2；
2) `lsof -iTCP:3080 -sTCP:LISTEN` 确认监听进程是重启后的新进程，且 /Users/chris/.local/state/dsh-update/prod-web.log 启动日志无错误、无插件加载失败(尤其 dsh-better-sidebar 0.21.1)；
3) 你能读到此消息即说明会话恢复成功；
4) 阅读 /Users/chris/.local/state/dsh-update/restart.log 与 /Users/chris/Project/dsh-update-staging/DEBUG-REPORT.md(若存在)，汇报重启结果；
5) 询问是否停掉调试实例(:5280，dev home 为 ~/.local/dsh-home-dev)。
本次更新：@deepseek-ai/dsh 0.1.5-rc.2 → 0.1.7-rc.2(npm)，源码 /Users/chris/Project/deepseek-harness(master@477b4f4205)；旧版本备份于 /Users/chris/Project/dsh-backup-0.1.5-rc.2。
MSG
WAKE_MESSAGE="$(cat "$STATE/wake-message.txt")"
RID="req-wake-$(date +%s)"
export RID SESSION_ID WAKE_MESSAGE
python3 > "$STATE/prompt-body.json" <<'PY'
import json, os
print(json.dumps({
    'type': 'client-request',
    'rpcId': os.environ['RID'],
    'method': 'session/prompt',
    'payload': {'args': {'request': {
        'requestId': os.environ['RID'],
        'sessionId': os.environ['SESSION_ID'],
        'mode': 'queue',
        'content': [{'type': 'text', 'text': os.environ['WAKE_MESSAGE']}],
        'clientTimeZone': 'Asia/Shanghai',
    }}},
}))
PY
OUT=$(curl -s -b "$COOKIES" -m 30 -X POST "http://127.0.0.1:$PROD_PORT/api/session/prompt" \
  -H "Content-Type: application/json" -H "Origin: http://127.0.0.1:$PROD_PORT" -d @"$STATE/prompt-body.json" 2>&1)
log "wake response: $OUT"
case "$OUT" in
  *'"ok":true'*) log "=== restart-prod.sh SUCCESS ==="; exit 0 ;;
  *)             log "=== restart-prod.sh: host is up but the wake prompt was rejected ==="; exit 1 ;;
esac
