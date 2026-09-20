#!/bin/bash
# dev-service.sh — manage the resident dev/test dsh web host (default :5280)
# as a launchd service, symmetric to the production host on :3280.
#
# Why a service: AGENTS.md requires the test environment to stay resident so
# production can dispatch to it at any moment. launchd gives KeepAlive crash
# resurrection, boot persistence, and — critically — kickstart -k ordering
# (old process fully gone, port released, then replacement starts), which is
# the single-writer guarantee for the sandbox journal. This enables the
# mutual-cover topology:
#
#   prod -> test:  scripts/dev-service.sh restart     (safe from a PROD
#                  session: the process being replaced is the test host, so
#                  the tool result persists on the surviving prod host)
#   test -> prod:  DSH_WEB_SERVICE_LABEL=... scripts/prod-restart.sh
#                  (from a 5280 session or an external terminal), or the
#                  unattended channel: prod files a request with
#                  scripts/prod-restart-request.sh and the watcher installed
#                  by `dev-service.sh install` executes it within a minute.
#
# Subcommands:
#   install   [--port 5280] [--home ~/.local/dsh-home-dev] [--profile web]
#   restart   [--port 5280]
#   refresh   (update the watcher's stable script copies; dev host untouched)
#   status    [--port 5280]
#   uninstall [--port 5280]   (keeps the sandbox home; only removes the service)
#
# install expects the sandbox home to be ASSEMBLED already (run
# scripts/dev-sandbox.sh first). If an ad-hoc sandbox owns the port (its pid
# file matches a live dsh process), install stops it and hands the port to
# the service — the sandbox is disposable by design. Afterwards, re-running
# dev-sandbox.sh bootouts this service while it reassembles the home and
# re-bootstraps it afterwards; the service never assembles the home itself.
set -euo pipefail

PORT=5280
SANDBOX_HOME="${DSH_DEV_HOME:-$HOME/.local/dsh-home-dev}"
PROFILE=web
CMD="${1:-}"
[ $# -gt 0 ] && shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --port) [ $# -ge 2 ] || { echo "dev-service.sh: --port needs a value" >&2; exit 2; }
      PORT="$2"; shift 2 ;;
    --home) [ $# -ge 2 ] || { echo "dev-service.sh: --home needs a value" >&2; exit 2; }
      SANDBOX_HOME="$2"; shift 2 ;;
    --profile) [ $# -ge 2 ] || { echo "dev-service.sh: --profile needs a value" >&2; exit 2; }
      PROFILE="$2"; shift 2 ;;
    *) echo "dev-service.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done

LABEL="io.shiliai.dsh-dev-$PORT"
WATCH_LABEL="io.shiliai.dsh-dev-restart-watch"
UID_N="$(id -u)"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/$LABEL.plist"
WATCH_PLIST="$PLIST_DIR/$WATCH_LABEL.plist"
SERVICE_DIR="$HOME/.local/dsh-dev-service"
RUN_WRAPPER="$SERVICE_DIR/run-$PORT.sh"
LOG_DIR="$HOME/.local/state/dsh-dev"
STDOUT_LOG="$LOG_DIR/dsh-dev-$PORT.stdout.log"
STDERR_LOG="$LOG_DIR/dsh-dev-$PORT.stderr.log"
PROD_PORT="${DSH_WEB_PORT:-3280}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Same hard rule as dev-sandbox.sh: this script must never manage the
# production port. With --port 3280 the install takeover branch could, after
# a pid recycle, identity-match the PRODUCTION host and SIGKILL it.
if [ "$PORT" = "$PROD_PORT" ]; then
  echo "dev-service.sh: refusing to manage the production port $PROD_PORT." >&2
  exit 2
fi
# Normalize the home so the value pinned into the launchd wrapper compares
# equal to the normalized path dev-sandbox.sh uses.
SANDBOX_HOME="$(python3 -c 'import os,sys; print(os.path.realpath(os.path.expanduser(sys.argv[1])))' "$SANDBOX_HOME")"

usage() { sed -n '2,31p' "$0"; }

listener_pid() { lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true; }
service_pid() { launchctl print "gui/$UID_N/$LABEL" 2>/dev/null | awk '$1 == "pid" && $2 == "=" {print $3; exit}'; }

# The launchd wrapper pins SANDBOX_HOME and the dsh bin at install time; both
# can go stale (different --home, pruned dsh-cli release). kickstarting a
# service with a stale wrapper means a KeepAlive crash-loop, so restart and
# the dev-sandbox handoff check this BEFORE touching anything.
check_wrapper() {
  [ -f "$RUN_WRAPPER" ] || return 1
  local w_home w_bin
  w_home="$(grep -m1 '^SANDBOX_HOME=' "$RUN_WRAPPER" 2>/dev/null | cut -d'"' -f2 || true)"
  w_bin="$(grep -m1 '^exec ' "$RUN_WRAPPER" 2>/dev/null | awk -F'"' '{print $4}' || true)"
  [ "$w_home" = "$SANDBOX_HOME" ] && [ -n "$w_bin" ] && [ -f "$w_bin" ]
}
refuse_stale_wrapper() {
  echo "dev-service.sh: the launchd wrapper $RUN_WRAPPER is missing or stale" >&2
  echo "  (pinned home/bin no longer match). Refusing; re-create it with:" >&2
  echo "  scripts/dev-service.sh uninstall && scripts/dev-service.sh install" >&2
  exit 1
}

resolve_dsh_bin() {
  # Same policy as dev-sandbox.sh: pin the bin of the RUNNING production host
  # (dev/prod version parity), then the newest dsh-cli release.
  local prod_pid bin
  prod_pid="$(lsof -tiTCP:"$PROD_PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
  if [ -n "$prod_pid" ]; then
    bin="$(ps -p "$prod_pid" -o command= 2>/dev/null | grep -o '[^ ]*dsh/lib/bin\.js' | head -1 || true)"
    if [ -n "$bin" ]; then echo "$bin"; return 0; fi
  fi
  bin="$(ls -d "$HOME"/.local/share/dsh-cli/releases/*/node_modules/.pnpm/@deepseek-ai+dsh@*/node_modules/@deepseek-ai/dsh/lib/bin.js 2>/dev/null | sort -V | tail -1 || true)"
  if [ -n "$bin" ]; then
    echo "$bin"
    echo "dev-service.sh: warning - production host not reachable on :$PROD_PORT; pinned newest release (version may differ from production)" >&2
    return 0
  fi
  return 1
}

wait_ready() {
  local i
  for i in $(seq 1 90); do
    if curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}

cmd_install() {
  if launchctl print "gui/$UID_N/$LABEL" >/dev/null 2>&1; then
    echo "dev-service.sh: $LABEL is already installed; use 'restart' or 'uninstall' first." >&2
    exit 1
  fi
  if [ ! -f "$SANDBOX_HOME/profiles/$PROFILE/package.json" ]; then
    echo "dev-service.sh: sandbox home is not assembled: $SANDBOX_HOME" >&2
    echo "  Run scripts/dev-sandbox.sh --plugin <name> first, then re-run install." >&2
    exit 1
  fi
  local bin node_bin
  bin="$(resolve_dsh_bin)" || { echo "dev-service.sh: cannot locate a dsh bin.js" >&2; exit 1; }
  node_bin="$(command -v node)" || { echo "dev-service.sh: node not on PATH" >&2; exit 1; }

  # Take over the port from an ad-hoc dev-sandbox.sh boot, identity-checked.
  local cur_pid pid_file old_pid
  cur_pid="$(listener_pid)"
  if [ -n "$cur_pid" ]; then
    pid_file="$SANDBOX_HOME/sandbox.pid"
    old_pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [ "$cur_pid" = "$old_pid" ] && ps -p "$cur_pid" -o command= 2>/dev/null | grep -q 'dsh/lib/bin\.js'; then
      echo "dev-service.sh: stopping ad-hoc sandbox (pid $cur_pid) to hand the port to the service..."
      kill "$cur_pid" 2>/dev/null || true
      local i
      for i in $(seq 1 20); do kill -0 "$cur_pid" 2>/dev/null || break; sleep 0.5; done
      kill -9 "$cur_pid" 2>/dev/null || true
    else
      echo "dev-service.sh: REFUSING to take over port $PORT." >&2
      echo "  It is owned by pid $cur_pid, which is not the ad-hoc sandbox recorded" >&2
      echo "  in $pid_file. Investigate before proceeding." >&2
      exit 1
    fi
  fi

  mkdir -p "$SERVICE_DIR" "$LOG_DIR" "$PLIST_DIR"
  cat > "$RUN_WRAPPER" <<EOF
#!/bin/bash
# Generated by dev-service.sh install ($(date '+%Y-%m-%d %H:%M:%S')) - regenerated
# on each install. launchd runs this as the resident dev/test host. It NEVER
# assembles the sandbox home: that is dev-sandbox.sh's job (and dev-sandbox.sh
# bootouts this service while it reassembles). Exits nonzero while the home is
# missing; ThrottleInterval keeps launchd from tight-looping.
set -u
SANDBOX_HOME="$SANDBOX_HOME"
if [ ! -f "\$SANDBOX_HOME/profiles/$PROFILE/package.json" ]; then
  echo "dev-service run: sandbox home \$SANDBOX_HOME is not assembled; run scripts/dev-sandbox.sh first." >&2
  exit 1
fi
export DSH_HOME="\$SANDBOX_HOME"
exec "$node_bin" "$bin" web --host 127.0.0.1 --port "$PORT" --no-open
EOF
  chmod 755 "$RUN_WRAPPER"

  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Generated by scripts/dev-service.sh install ($(date '+%Y-%m-%d %H:%M:%S')).
     The dev/test host counterpart of the production service: KeepAlive for
     residency, kickstart -k for single-writer restarts. Regenerate with
     scripts/dev-service.sh uninstall && install; do not hand-edit. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$RUN_WRAPPER</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>$HOME</string>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>$STDOUT_LOG</string>
  <key>StandardErrorPath</key>
  <string>$STDERR_LOG</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
</dict>
</plist>
EOF
  plutil -lint "$PLIST" >/dev/null

  launchctl bootstrap "gui/$UID_N" "$PLIST"
  echo "dev-service.sh: $LABEL bootstrapped; waiting for 127.0.0.1:$PORT..."
  if wait_ready; then
    local spid token_url new_pid
    spid="$(service_pid || true)"
    # Post-check, same as cmd_restart: the answering listener must be OUR
    # service, not a third party that grabbed the port in the handover gap.
    new_pid="$(listener_pid)"
    if [ -z "$new_pid" ] || [ "$new_pid" != "$spid" ]; then
      echo "dev-service.sh: post-check FAILED - port $PORT answered by pid ${new_pid:-<none>}, service reports pid ${spid:-<none>}." >&2
      exit 1
    fi
    token_url="$(grep -o "http://127\.0\.0\.1:$PORT/?token=[A-Za-z0-9_-]*" "$STDOUT_LOG" 2>/dev/null | tail -1 || true)"
    echo "dev-service.sh: dev host is resident on 127.0.0.1:$PORT (service pid ${spid:-<pending>})."
    echo "  UI: ${token_url:-<see $STDOUT_LOG for the token URL>}"
    echo "  Restart from production any time: scripts/dev-service.sh restart"
  else
    echo "dev-service.sh: service did not answer on :$PORT within 90s; check $STDERR_LOG" >&2
    exit 1
  fi

  install_restart_watch
}

# The unattended prod->test->prod channel: a tiny launchd watcher (independent
# of the sandbox process and its bundle composition) that polls the shared
# workflow dir and executes prod-restart.sh when production has filed a
# request via prod-restart-request.sh. The scripts run from STABLE COPIES in
# $SERVICE_DIR — never from the repo checkout, which may be a worktree that
# gets deleted after its PR merges.
install_restart_watch() {
  cp "$REPO_ROOT/scripts/prod-restart-watch.sh" "$REPO_ROOT/scripts/prod-restart.sh" "$SERVICE_DIR/"
  chmod 755 "$SERVICE_DIR/prod-restart-watch.sh" "$SERVICE_DIR/prod-restart.sh"
  cat > "$WATCH_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Generated by scripts/dev-service.sh install. Polls the restart-request
     dir every 60s and executes prod-restart.sh on behalf of production.
     Runs the stable copies in $SERVICE_DIR, not the repo checkout. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$WATCH_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$SERVICE_DIR/prod-restart-watch.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>$HOME</string>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/restart-watch.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/restart-watch.stderr.log</string>
  <key>StartInterval</key>
  <integer>60</integer>
</dict>
</plist>
EOF
  plutil -lint "$WATCH_PLIST" >/dev/null
  launchctl bootout "gui/$UID_N/$WATCH_LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_N" "$WATCH_PLIST"
  echo "dev-service.sh: restart watcher installed ($WATCH_LABEL, every 60s)."
  echo "  Production files a request with: scripts/prod-restart-request.sh"
}

cmd_restart() {
  launchctl print "gui/$UID_N/$LABEL" >/dev/null 2>&1 || {
    echo "dev-service.sh: $LABEL is not installed; run 'install' first." >&2
    exit 1
  }
  # Port-ownership pre-check, symmetric to prod-restart.sh: if a non-service
  # process owns the port, kickstart -k would not stop it, and the KeepAlive
  # relaunch would briefly open the same sandbox home while the squatter
  # still serves — two writers on one DSH_HOME. Refuse instead.
  check_wrapper || refuse_stale_wrapper
  local old_pid spid_before
  old_pid="$(listener_pid)"
  spid_before="$(service_pid || true)"
  if [ -n "$old_pid" ] && [ "$old_pid" != "$spid_before" ]; then
    echo "dev-service.sh: REFUSING to restart." >&2
    echo "  Port $PORT is owned by pid $old_pid, which is NOT service $LABEL" >&2
    echo "  (pid ${spid_before:-<none>}). Stop the squatter first (if it is an ad-hoc" >&2
    echo "  dev-sandbox.sh boot: kill the pid in $SANDBOX_HOME/sandbox.pid)." >&2
    exit 1
  fi
  echo "dev-service.sh: kickstart -k $LABEL (launchd stops the old process and"
  echo "waits for its port before starting the replacement - single-writer)."
  launchctl kickstart -k "gui/$UID_N/$LABEL"
  if [ -n "$old_pid" ]; then
    local i
    for i in $(seq 1 30); do
      [ "$(listener_pid)" != "$old_pid" ] && break
      sleep 1
    done
  fi
  if wait_ready; then
    local new_pid spid
    new_pid="$(listener_pid)"
    spid="$(service_pid || true)"
    if [ -z "$new_pid" ] || [ "$new_pid" != "$spid" ]; then
      echo "dev-service.sh: post-check FAILED - port $PORT answered by pid ${new_pid:-<none>}, service reports pid ${spid:-<none>}." >&2
      exit 1
    fi
    echo "dev-service.sh: dev host is back on 127.0.0.1:$PORT (service pid $spid)."
  else
    echo "dev-service.sh: dev host did not answer on :$PORT within 90s; check $STDERR_LOG" >&2
    exit 1
  fi
}

# Refresh the stable script copies the watcher runs, without touching the dev
# host itself. Use after pulling repo changes to prod-restart-watch.sh /
# prod-restart.sh — the watcher runs the COPIES in $SERVICE_DIR, so repo fixes
# never reach the unattended channel until refreshed.
cmd_refresh() {
  launchctl print "gui/$UID_N/$WATCH_LABEL" >/dev/null 2>&1 || {
    echo "dev-service.sh: watcher $WATCH_LABEL is not installed; run 'install' first." >&2
    exit 1
  }
  cp "$REPO_ROOT/scripts/prod-restart-watch.sh" "$REPO_ROOT/scripts/prod-restart.sh" "$SERVICE_DIR/"
  chmod 755 "$SERVICE_DIR/prod-restart-watch.sh" "$SERVICE_DIR/prod-restart.sh"
  launchctl kickstart "gui/$UID_N/$WATCH_LABEL"
  echo "dev-service.sh: watcher scripts refreshed from $REPO_ROOT/scripts/ (dev host untouched)."
}

cmd_status() {
  local spid lpid
  spid="$(service_pid || true)"
  lpid="$(listener_pid)"
  echo "service:  $LABEL $(launchctl print "gui/$UID_N/$LABEL" >/dev/null 2>&1 && echo loaded || echo NOT-LOADED) (pid ${spid:-<none>})"
  echo "port:     127.0.0.1:$PORT listener pid ${lpid:-<none>}"
  if [ -n "$lpid" ] && [ "$lpid" = "$spid" ]; then
    echo "health:   $(curl -s -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" 2>/dev/null || echo unreachable)"
  else
    echo "health:   port/service mismatch or down"
  fi
  echo "watcher:  $WATCH_LABEL $(launchctl print "gui/$UID_N/$WATCH_LABEL" >/dev/null 2>&1 && echo loaded || echo NOT-LOADED)"
  echo "home:     $SANDBOX_HOME"
}

cmd_uninstall() {
  launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null || true
  launchctl bootout "gui/$UID_N/$WATCH_LABEL" 2>/dev/null || true
  rm -f "$PLIST" "$WATCH_PLIST" "$RUN_WRAPPER" "$SERVICE_DIR/prod-restart-watch.sh" "$SERVICE_DIR/prod-restart.sh"
  echo "dev-service.sh: $LABEL and $WATCH_LABEL removed. Sandbox home kept: $SANDBOX_HOME"
}

case "$CMD" in
  install) cmd_install ;;
  restart) cmd_restart ;;
  refresh) cmd_refresh ;;
  status) cmd_status ;;
  uninstall) cmd_uninstall ;;
  -h|--help|"") usage; [ -n "$CMD" ] && exit 0 || exit 2 ;;
  *) echo "dev-service.sh: unknown subcommand: $CMD" >&2; usage; exit 2 ;;
esac
