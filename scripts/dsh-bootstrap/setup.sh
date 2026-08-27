#!/usr/bin/env sh
# dsh-bootstrap launcher — macOS/Linux.
#
# Run one of:
#   node scripts/dsh-bootstrap/bootstrap.mjs          (from a repo clone)
#   curl -fsSL https://raw.githubusercontent.com/shiliai/dsh-plugins/main/scripts/dsh-bootstrap/setup.sh | sh
#
# Requirements: git and Node.js (>=22). dsh itself requires Node too, and the
# bootstrap can install dsh for you.
set -e

REPO=https://github.com/shiliai/dsh-plugins.git
HERE="$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd)"

if [ -f "$HERE/bootstrap.mjs" ]; then
  BOOT_DIR="$HERE"
else
  CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/dsh-bootstrap"
  if [ ! -f "$CACHE/scripts/dsh-bootstrap/bootstrap.mjs" ]; then
    rm -rf "$CACHE"
    git clone --depth 1 --filter=blob:none --sparse "$REPO" "$CACHE" >/dev/null 2>&1
    git -C "$CACHE" sparse-checkout set scripts/dsh-bootstrap >/dev/null 2>&1 || true
  fi
  BOOT_DIR="$CACHE/scripts/dsh-bootstrap"
fi

exec node "$BOOT_DIR/bootstrap.mjs" "$@"
