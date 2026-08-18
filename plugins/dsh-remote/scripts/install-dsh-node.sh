#!/bin/sh
set -eu
umask 077

dsh_home=${DSH_HOME_TARGET:-"$HOME/.local/dsh_home"}
install_root=${DSH_INSTALL_ROOT:-"$HOME/.local/share/dsh-cli"}
launcher=${DSH_LAUNCHER:-"$HOME/.local/bin/dsh"}
version=${DSH_VERSION:-0.1.0-rc.6}
source_repo=${DSH_SOURCE_REPO:-"$HOME/project/Agents/deepseek-harness"}
source_commit=${DSH_SOURCE_COMMIT:-15148dbd9a1d1f1ef1a26e5749b32af0cd663935}
state_root=${DSH_INSTALL_STATE_ROOT:-"$HOME/.local/state/dsh-node-installer"}
marker="$dsh_home/.managed-by-dsh-node-installer"

sha256_file() {
  openssl dgst -sha256 "$1" | awk '{print $NF}'
}

replace_symlink() {
  target=$1
  link=$2
  temporary="$link.tmp.$$"
  ln -s "$target" "$temporary"
  python3 - "$temporary" "$link" <<'PY'
import os, sys
os.replace(sys.argv[1], sys.argv[2])
PY
}

replace_private_file() {
  source=$1
  target=$2
  temporary="$target.tmp.$$"
  install -m 600 "$source" "$temporary"
  python3 - "$temporary" "$target" <<'PY'
import os, sys
os.replace(sys.argv[1], sys.argv[2])
PY
}

usage() {
  echo "usage: install-dsh-node.sh SETTINGS_YAML CREDENTIALS_YAML" >&2
  echo "       install-dsh-node.sh --rollback RECEIPT_ID" >&2
  exit 2
}

lock_acquire() {
  install -d -m 700 "$state_root"
  lock="$state_root/install.lock"
  if ! mkdir "$lock" 2>/dev/null; then
    echo "dsh-node: another install or rollback is active" >&2
    exit 1
  fi
  trap 'rmdir "$lock" 2>/dev/null || true' EXIT HUP INT TERM
}

restore_item() {
  name=$1
  target=$2
  if [ -e "$receipt/backup/$name" ] || [ -L "$receipt/backup/$name" ]; then
    rm -rf "$target"
    install -d -m 700 "$(dirname "$target")"
    cp -a "$receipt/backup/$name" "$target"
  elif [ -f "$receipt/backup/$name.absent" ]; then
    rm -rf "$target"
  fi
}

rollback_receipt() {
  receipt_id=$1
  case "$receipt_id" in ''|*[!A-Za-z0-9TZ._-]*) usage ;; esac
  receipt="$state_root/receipts/$receipt_id"
  [ -f "$receipt/receipt.env" ] || { echo "dsh-node: rollback receipt not found" >&2; exit 1; }
  status=$(sed -n 's/^status=//p' "$receipt/receipt.env")
  [ "$status" != rolled_back ] || { echo "dsh-node: receipt already rolled back"; return; }
  expected=$(sed -n 's/^new_release=//p' "$receipt/receipt.env")
  expected_config=$(sed -n 's/^new_config=//p' "$receipt/receipt.env")
  current=$(readlink "$install_root/current" 2>/dev/null || true)
  current_config=$(readlink "$install_root/configs/current" 2>/dev/null || true)
  [ "$current" = "$expected" ] && [ "$current_config" = "${expected_config#configs/}" ] || { echo "dsh-node: rollback chain mismatch; roll back newest receipt first" >&2; exit 1; }
  restore_item launcher "$launcher"
  restore_item settings "$dsh_home/settings.yaml"
  restore_item credentials "$dsh_home/.credentials.yaml"
  restore_item marker "$marker"
  restore_item current "$install_root/current"
  restore_item config-current "$install_root/configs/current"
  sed 's/^status=.*/status=rolled_back/' "$receipt/receipt.env" > "$receipt/receipt.env.tmp"
  chmod 600 "$receipt/receipt.env.tmp"
  mv "$receipt/receipt.env.tmp" "$receipt/receipt.env"
  echo "dsh-node: rolled back receipt $receipt_id"
}

if [ "$#" -eq 2 ] && [ "$1" = --rollback ]; then
  lock_acquire
  rollback_receipt "$2"
  exit 0
fi
[ "$#" -eq 2 ] || usage
settings_source=$1
credentials_source=$2

for source in "$settings_source" "$credentials_source"; do
  [ -f "$source" ] || { echo "dsh-node: required source is missing: $source" >&2; exit 1; }
done
git -C "$source_repo" cat-file -e "$source_commit^{commit}" || {
  echo "dsh-node: immutable DSH source commit is unavailable: $source_commit" >&2
  exit 1
}
[ ! -e "$dsh_home" ] || [ -f "$marker" ] || { echo "dsh-node: refusing to overwrite unmanaged DSH_HOME: $dsh_home" >&2; exit 1; }
[ ! -e "$launcher" ] || [ -f "$marker" ] || { echo "dsh-node: refusing to overwrite unmanaged launcher: $launcher" >&2; exit 1; }

lock_acquire
stamp=$(date -u +%Y%m%dT%H%M%SZ)
receipt_id="$stamp-$source_commit"
receipt="$state_root/receipts/$receipt_id"
suffix=0
while [ -e "$receipt" ]; do suffix=$((suffix + 1)); receipt="$state_root/receipts/$receipt_id-$suffix"; done
receipt_id=$(basename "$receipt")
install -d -m 700 "$receipt/backup" "$install_root/releases" "$install_root/configs" "$(dirname "$launcher")" "$dsh_home"

backup_item() {
  name=$1
  target=$2
  if [ -e "$target" ] || [ -L "$target" ]; then cp -a "$target" "$receipt/backup/$name"; else : > "$receipt/backup/$name.absent"; fi
}
backup_item launcher "$launcher"
backup_item settings "$dsh_home/settings.yaml"
backup_item credentials "$dsh_home/.credentials.yaml"
backup_item marker "$marker"
backup_item current "$install_root/current"
backup_item config-current "$install_root/configs/current"

release_id="$version-$source_commit"
release="$install_root/releases/$release_id"
config_id="$release_id-$({ sha256_file "$settings_source"; sha256_file "$credentials_source"; } | openssl dgst -sha256 | awk '{print $NF}')"
config="$install_root/configs/$config_id"
new_release="releases/$release_id"
{
  echo 'schema=dsh-node-install-receipt-v2'
  echo 'status=prepared'
  printf 'new_release=%s\n' "$new_release"
  printf 'new_config=configs/%s\n' "$config_id"
} > "$receipt/receipt.env"
chmod 600 "$receipt/receipt.env"

committed=false
restore_failed_install() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$committed" != true ]; then
    restore_item launcher "$launcher"
    restore_item settings "$dsh_home/settings.yaml"
    restore_item credentials "$dsh_home/.credentials.yaml"
    restore_item marker "$marker"
    restore_item current "$install_root/current"
    restore_item config-current "$install_root/configs/current"
    sed 's/^status=.*/status=failed-restored/' "$receipt/receipt.env" > "$receipt/receipt.env.tmp" 2>/dev/null || true
    [ ! -f "$receipt/receipt.env.tmp" ] || { chmod 600 "$receipt/receipt.env.tmp"; mv "$receipt/receipt.env.tmp" "$receipt/receipt.env"; }
  fi
  rmdir "$lock" 2>/dev/null || true
  exit "$status"
}
trap restore_failed_install EXIT HUP INT TERM

if [ ! -d "$release" ]; then
  stage="$release.stage.$$"
  rm -rf "$stage"
  install -d -m 700 "$stage"
  git -C "$source_repo" archive "$source_commit" | tar -x -C "$stage"
  (
    cd "$stage"
    install -d -m 700 .corepack-bin
    corepack enable --install-directory "$stage/.corepack-bin" pnpm
    PATH="$stage/.corepack-bin:$PATH" pnpm install --frozen-lockfile
    PATH="$stage/.corepack-bin:$PATH" pnpm run build
  )
  [ "${DSH_INSTALL_FAIL_AT:-}" != after-release-build ] || { echo "dsh-node: injected failure after-release-build" >&2; exit 1; }
  mv "$stage" "$release"
fi

if [ ! -d "$config" ]; then
  stage_config="$config.stage.$$"
  install -d -m 700 "$stage_config"
  install -m 600 "$settings_source" "$stage_config/settings.yaml"
  install -m 600 "$credentials_source" "$stage_config/.credentials.yaml"
  mv "$stage_config" "$config"
fi
[ "${DSH_INSTALL_FAIL_AT:-}" != after-config-stage ] || { echo "dsh-node: injected failure after-config-stage" >&2; exit 1; }

replace_symlink "$new_release" "$install_root/current"
replace_symlink "$config_id" "$install_root/configs/current"
replace_private_file "$install_root/configs/current/settings.yaml" "$dsh_home/settings.yaml"
replace_private_file "$install_root/configs/current/.credentials.yaml" "$dsh_home/.credentials.yaml"
[ "${DSH_INSTALL_FAIL_AT:-}" != after-pointer-switch ] || { echo "dsh-node: injected failure after-pointer-switch" >&2; exit 1; }

launcher_tmp="$launcher.tmp.$$"
{
  echo '#!/bin/sh'
  printf 'export DSH_HOME=%s\n' "$dsh_home"
  printf 'exec node %s/current/apps/cli/lib/bin.js "$@"\n' "$install_root"
} > "$launcher_tmp"
chmod 755 "$launcher_tmp"
mv "$launcher_tmp" "$launcher"
install -m 600 /dev/null "$marker"

actual=$("$launcher" --version)
[ "$actual" = "$version" ] || { echo "dsh-node: expected $version, observed $actual" >&2; exit 1; }
"$launcher" web --dump-config >/dev/null
[ "${DSH_INSTALL_FAIL_AT:-}" != after-validation ] || { echo "dsh-node: injected failure after-validation" >&2; exit 1; }

sed 's/^status=.*/status=committed/' "$receipt/receipt.env" > "$receipt/receipt.env.tmp"
{
  printf 'launcher_sha256=%s\n' "$(sha256_file "$launcher")"
  printf 'settings_sha256=%s\n' "$(sha256_file "$dsh_home/settings.yaml")"
  printf 'credentials_sha256=%s\n' "$(sha256_file "$dsh_home/.credentials.yaml")"
} >> "$receipt/receipt.env.tmp"
chmod 600 "$receipt/receipt.env.tmp"
mv "$receipt/receipt.env.tmp" "$receipt/receipt.env"
committed=true
trap - EXIT HUP INT TERM
rmdir "$lock"
printf 'dsh-node: installed dsh %s with DSH_HOME=%s receipt=%s\n' "$actual" "$dsh_home" "$receipt_id"
