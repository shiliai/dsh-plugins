#!/usr/bin/env bash
# install-proxy.sh — install the GBrain MCP auth proxy + agent preset on macOS.
#
# What it does:
#   1. copies agent-preset/  -> $DSH_HOME/.agent-presets/gbrain/
#   2. installs the proxy script -> ~/.local/libexec/gbrain-mcp-proxy/
#   3. generates + bootstraps a launchd agent (RunAtLoad + KeepAlive) with the
#      GBRAIN_* credentials baked into the plist (never committed anywhere)
#   4. health-checks the proxy
#
# Usage:
#   GBRAIN_CLIENT_ID=gbrain_cl_... GBRAIN_CLIENT_SECRET=gbrain_cs_... \
#     ./install-proxy.sh
#
# Optional env:
#   GBRAIN_UPSTREAM   required, e.g. http://<gbrain-lan-host>:3131
#   GBRAIN_PROXY_PORT default 3137
#   DSH_HOME          default ~/.local/dsh_home
#   LABEL             default io.shiliai.gbrain-mcp-proxy
#
# Credentials come from your environment only; this script and the files it
# copies into the repo never contain them.
set -euo pipefail

LABEL="${LABEL:-io.shiliai.gbrain-mcp-proxy}"
PORT="${GBRAIN_PROXY_PORT:-3137}"
DSH_HOME="${DSH_HOME:-$HOME/.local/dsh_home}"
LIBEXEC="$HOME/.local/libexec/gbrain-mcp-proxy"
STATE_DIR="$HOME/.local/state/gbrain-mcp-proxy"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail() { echo "error: $*" >&2; exit 1; }

command -v node >/dev/null || fail "node is required"
command -v curl >/dev/null || fail "curl is required"
[[ -n "${GBRAIN_CLIENT_ID:-}" ]] || fail "GBRAIN_CLIENT_ID is required"
[[ -n "${GBRAIN_CLIENT_SECRET:-}" ]] || fail "GBRAIN_CLIENT_SECRET is required"
[[ -n "${GBRAIN_UPSTREAM:-}" ]] || fail "GBRAIN_UPSTREAM is required (e.g. http://<gbrain-lan-host>:3131)"

NODE_BIN="$(command -v node)"

echo "==> installing agent preset into $DSH_HOME/.agent-presets/gbrain"
mkdir -p "$DSH_HOME/.agent-presets"
rm -rf "$DSH_HOME/.agent-presets/gbrain"
cp -R "$REPO_DIR/agent-preset" "$DSH_HOME/.agent-presets/gbrain"
chmod -R u+rwX,go-rwx "$DSH_HOME/.agent-presets/gbrain"

echo "==> installing proxy script into $LIBEXEC"
mkdir -p "$LIBEXEC" "$STATE_DIR"
cp "$REPO_DIR/proxy/gbrain-mcp-proxy.js" "$LIBEXEC/gbrain-mcp-proxy.js"
chmod 600 "$LIBEXEC/gbrain-mcp-proxy.js"

echo "==> writing $PLIST"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$LIBEXEC/gbrain-mcp-proxy.js</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>GBRAIN_PROXY_PORT</key>
    <string>$PORT</string>
    <key>GBRAIN_CLIENT_ID</key>
    <string>$GBRAIN_CLIENT_ID</string>
    <key>GBRAIN_CLIENT_SECRET</key>
    <string>$GBRAIN_CLIENT_SECRET</string>
$(if [[ -n "${GBRAIN_UPSTREAM:-}" ]]; then
    printf '    <key>GBRAIN_UPSTREAM</key>\n    <string>%s</string>\n' "$GBRAIN_UPSTREAM"
fi)
  </dict>
  <key>StandardOutPath</key>
  <string>$STATE_DIR/launchd.log</string>
  <key>StandardErrorPath</key>
  <string>$STATE_DIR/launchd.log</string>
</dict>
</plist>
EOF
chmod 600 "$PLIST"

echo "==> bootstrapping launchd agent"
UID_NUM="$(id -u)"
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST"

echo -n "==> health check: "
for _ in 1 2 3 4 5; do
  sleep 1
  if curl -fsS -m 3 "http://127.0.0.1:$PORT/proxy-health" 2>/dev/null; then
    echo
    echo "done. preset: restart the DSH web host externally if the mode picker"
    echo "does not yet list 「GBrain 模式」, then pick it on a NEW session."
    exit 0
  fi
  echo -n "."
done
echo
fail "proxy did not come up; check $STATE_DIR/launchd.log"
