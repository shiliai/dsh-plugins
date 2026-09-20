#!/bin/bash
# dev-sandbox.sh — boot a disposable dev dsh web instance (default :5280) that
# serves worktree builds of the selected plugins, with Cordis HMR pointed at
# their lib/ directories. This is the "5280 dev" half of the dev/prod split
# workflow documented in AGENTS.md; the production host on :3280 is never
# touched.
#
# Usage:
#   scripts/dev-sandbox.sh --plugin dsh-file-attachment [--plugin dsh-reading ...]
#                          [--port 5280] [--home ~/.local/dsh-home-dev]
#                          [--profile web] [--no-build]
#
# The sandbox is cheap and disposable: it clones the production profile with
# APFS copy-on-write clones, trims the bundle list to base + web + the target
# plugins, and injects a dev overlay (hmr root -> worktree lib, installed copy
# disabled, worktree build inserted). Re-run the script after changing the
# overlay ingredients; code iterations hot-reload via HMR in 1–2s
# (DSH_DEV_HOT_LOOP=1 pnpm build in the plugin directory).
#
# Never point --home at the production DSH_HOME: two live hosts on one home
# are two writers on one session journal (see AGENTS.md "DSH restart safety").
set -euo pipefail

PORT=5280
SANDBOX_HOME="${DSH_DEV_HOME:-$HOME/.local/dsh-home-dev}"
PROFILE=web
BUILD=1
PLUGINS=()

usage() { sed -n '2,22p' "$0"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --plugin) [ $# -ge 2 ] || { echo "dev-sandbox.sh: --plugin needs a value" >&2; exit 2; }
      PLUGINS+=("$2"); shift 2 ;;
    --port) [ $# -ge 2 ] || { echo "dev-sandbox.sh: --port needs a value" >&2; exit 2; }
      PORT="$2"; shift 2 ;;
    --home) [ $# -ge 2 ] || { echo "dev-sandbox.sh: --home needs a value" >&2; exit 2; }
      SANDBOX_HOME="$2"; shift 2 ;;
    --profile) [ $# -ge 2 ] || { echo "dev-sandbox.sh: --profile needs a value" >&2; exit 2; }
      PROFILE="$2"; shift 2 ;;
    --no-build) BUILD=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "dev-sandbox.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROD_HOME="${DSH_HOME:-$HOME/.local/dsh_home}"
PROD_PROFILE="$PROD_HOME/profiles/$PROFILE"

# Normalize the sandbox home before it ever feeds rm -rf: spellings like
# ~/.local/dsh_home/ or a symlinked alias must not bypass the guard below.
[ -n "$SANDBOX_HOME" ] || { echo "dev-sandbox.sh: sandbox home must not be empty." >&2; exit 2; }
SANDBOX_HOME="$(python3 -c 'import os,sys; print(os.path.realpath(os.path.expanduser(sys.argv[1])))' "$SANDBOX_HOME")"
PROD_HOME_NORM="$(python3 -c 'import os,sys; print(os.path.realpath(os.path.expanduser(sys.argv[1])))' "$PROD_HOME")"
SB_PROFILE="$SANDBOX_HOME/profiles/$PROFILE"
PID_FILE="$SANDBOX_HOME/sandbox.pid"
LOG_FILE="$SANDBOX_HOME/sandbox.log"

if [ "${#PLUGINS[@]}" -eq 0 ]; then
  echo "dev-sandbox.sh: pass at least one --plugin <name> (repo directory under plugins/)." >&2
  exit 2
fi
for p in "${PLUGINS[@]}"; do
  if [ ! -d "$REPO_ROOT/plugins/$p/src" ]; then
    echo "dev-sandbox.sh: plugins/$p does not exist in $REPO_ROOT" >&2
    exit 2
  fi
done
PROD_PORT="${DSH_WEB_PORT:-3280}"
if [ "$PORT" = "$PROD_PORT" ]; then
  echo "dev-sandbox.sh: refusing to serve the sandbox on the production port $PROD_PORT." >&2
  exit 2
fi
if [ "$SANDBOX_HOME" = "$PROD_HOME_NORM" ] || [ "$SANDBOX_HOME" = "$PROD_HOME" ]; then
  echo "dev-sandbox.sh: refusing to use the production DSH_HOME as the sandbox home." >&2
  exit 2
fi
case "$SANDBOX_HOME" in
  /|"$HOME")
    echo "dev-sandbox.sh: refusing dangerous sandbox home: $SANDBOX_HOME" >&2
    exit 2 ;;
esac
if [ ! -d "$PROD_PROFILE" ]; then
  echo "dev-sandbox.sh: production profile not found: $PROD_PROFILE" >&2
  exit 1
fi

# --- dsh binary -------------------------------------------------------------
# Bypass the `dsh` launcher shim (it hard-exports DSH_HOME). Prefer the bin
# of the RUNNING production host (dev/prod version parity), then an explicit
# override, then the newest dsh-cli release, then a global install.
DSH_BIN="${DSH_BIN:-}"
BIN_SOURCE="explicit DSH_BIN"
if [ -z "$DSH_BIN" ]; then
  PROD_PID="$(lsof -tiTCP:"$PROD_PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
  if [ -n "$PROD_PID" ]; then
    DSH_BIN="$(ps -p "$PROD_PID" -o command= 2>/dev/null | grep -o '[^ ]*dsh/lib/bin\.js' | head -1 || true)"
    [ -n "$DSH_BIN" ] && BIN_SOURCE="running production host (pid $PROD_PID)"
  fi
fi
if [ -z "$DSH_BIN" ]; then
  DSH_BIN="$(ls -d "$HOME"/.local/share/dsh-cli/releases/*/node_modules/.pnpm/@deepseek-ai+dsh@*/node_modules/@deepseek-ai/dsh/lib/bin.js 2>/dev/null | sort -V | tail -1 || true)"
  [ -n "$DSH_BIN" ] && BIN_SOURCE="newest dsh-cli release (production host not reachable — version may differ from production)"
fi
if [ -z "$DSH_BIN" ] && [ -f /opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js ]; then
  DSH_BIN=/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js
fi
if [ -z "$DSH_BIN" ] || [ ! -f "$DSH_BIN" ]; then
  echo "dev-sandbox.sh: cannot locate a dsh bin.js; set DSH_BIN=<path>." >&2
  exit 1
fi

# --- build worktree copies --------------------------------------------------
for p in "${PLUGINS[@]}"; do
  if [ "$BUILD" = 1 ]; then
    echo "dev-sandbox.sh: building plugins/$p (DSH_DEV_HOT_LOOP=1)..."
    (cd "$REPO_ROOT/plugins/$p" && DSH_DEV_HOT_LOOP=1 pnpm build)
  fi
  if [ ! -f "$REPO_ROOT/plugins/$p/lib/index.js" ]; then
    echo "dev-sandbox.sh: plugins/$p has no lib/index.js; build it first." >&2
    exit 1
  fi
done

# --- stop a previous sandbox (never the production host) --------------------
if [ -f "$PID_FILE" ]; then
  OLD_PID="$(cat "$PID_FILE" || true)"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    # Pids get recycled; only kill a process that really is a dsh host.
    if ps -p "$OLD_PID" -o command= 2>/dev/null | grep -q 'dsh/lib/bin\.js'; then
      echo "dev-sandbox.sh: stopping previous sandbox (pid $OLD_PID)..."
      kill "$OLD_PID" 2>/dev/null || true
      for _ in $(seq 1 20); do kill -0 "$OLD_PID" 2>/dev/null || break; sleep 0.5; done
      kill -9 "$OLD_PID" 2>/dev/null || true
    else
      echo "dev-sandbox.sh: pid $OLD_PID from $PID_FILE is not a dsh host; leaving it alone."
    fi
  fi
fi
if lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "dev-sandbox.sh: port $PORT is already in use; refusing to take it over." >&2
  exit 1
fi

# --- assemble the sandbox home ----------------------------------------------
echo "dev-sandbox.sh: assembling sandbox home at $SANDBOX_HOME..."
rm -rf "$SANDBOX_HOME"
mkdir -p "$SANDBOX_HOME/profiles"
cp -Rc "$PROD_PROFILE" "$SB_PROFILE"
# Minimal settings: the production settings.yaml may carry hand-edited sections
# that a cold parser rejects, and provider/model config is irrelevant for
# plugin e2e.
printf 'ui-onboarding:\n  welcomeNoticeVersion: 2026-08-13.1\n' > "$SANDBOX_HOME/settings.yaml"
# Trim the bundle list to base + web + the target plugins so sandboxed side
# plugins (wecom bridge, cron scheduler, ...) never activate.
BUNDLES="\"@deepseek-ai/dsh-base\", \"@deepseek-ai/dsh-web-app\""
for p in "${PLUGINS[@]}"; do BUNDLES="$BUNDLES, \"@dsh-plugins/$p\""; done
node -e "
  const fs = require('fs')
  const file = process.argv[1]
  const m = JSON.parse(fs.readFileSync(file, 'utf8'))
  m.dsh.profile.bundles = [$BUNDLES]
  fs.writeFileSync(file, JSON.stringify(m, null, 2) + '\n')
" "$SB_PROFILE/package.json"

# --- inject the dev overlay -------------------------------------------------
# Same recipe as issue #110, verified end-to-end: enable the bundle's hmr
# entry with root -> worktree lib, disable the installed copy, insert the
# worktree build (relative name anchored at the patch file's directory).
{
  echo ""
  echo "# --- dev sandbox overlay (auto-generated by scripts/dev-sandbox.sh) ---"
  echo "# Delete this block or re-run dev-sandbox.sh to restore the installed copy."
  echo "- id: hmr"
  echo "  disabled: false"
  echo "  config:"
  echo "    root:"
  for p in "${PLUGINS[@]}"; do echo "      - $REPO_ROOT/plugins/$p/lib"; done
  echo "    debounce: 200"
  for p in "${PLUGINS[@]}"; do
    echo "- id: $p"
    echo "  disabled: true"
  done
  echo "- insert:"
  for p in "${PLUGINS[@]}"; do
    REL="$(python3 -c 'import os,sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))' "$REPO_ROOT/plugins/$p/lib/index.js" "$SB_PROFILE")"
    echo "    - id: $p-dev"
    echo "      name: $REL"
    echo "      config: {}"
  done
} >> "$SB_PROFILE/cordis.patch.yml"

# --- boot -------------------------------------------------------------------
echo "dev-sandbox.sh: booting dsh web on 127.0.0.1:$PORT (log: $LOG_FILE)"
echo "dev-sandbox.sh: dsh bin: $DSH_BIN (source: $BIN_SOURCE)"
DSH_HOME="$SANDBOX_HOME" node "$DSH_BIN" web --host 127.0.0.1 --port "$PORT" --no-open \
  >"$LOG_FILE" 2>&1 &
SB_PID=$!
echo "$SB_PID" > "$PID_FILE"

READY=0
for _ in $(seq 1 60); do
  if ! kill -0 "$SB_PID" 2>/dev/null; then
    echo "dev-sandbox.sh: sandbox exited during boot; see $LOG_FILE" >&2
    exit 1
  fi
  if curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then READY=1; break; fi
  sleep 1
done
if [ "$READY" != 1 ]; then
  echo "dev-sandbox.sh: sandbox did not start listening within 60s; see $LOG_FILE" >&2
  exit 1
fi

TOKEN_URL="$(grep -o 'http://127\.0\.0\.1:[0-9]*/?token=[A-Za-z0-9_-]*' "$LOG_FILE" | tail -1 || true)"
echo ""
echo "dev-sandbox.sh: sandbox is up (pid $SB_PID)."
echo "  UI:        ${TOKEN_URL:-http://127.0.0.1:$PORT/ (token printed in $LOG_FILE)}"
echo "  e2e probe: scripts/e2e-probe.sh --base http://127.0.0.1:$PORT"
echo ""
echo "Inner loop: edit src -> DSH_DEV_HOT_LOOP=1 pnpm build (in plugins/<name>) ->"
echo "the sandbox hot-reloads in ~1-2s; refresh the browser. Overlay changes"
echo "(adding a plugin, config) require re-running this script."
echo ""
echo "Note: the sandbox home is rebuilt from scratch on every run; only the"
echo "profile is cloned. Credentials (.credentials.yaml) and root .env are NOT"
echo "copied - plugins that need them will run with missing config."
