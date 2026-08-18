#!/bin/sh
set -eu

if [ "$#" -lt 2 ] || [ "$#" -gt 5 ]; then
  echo "usage: install-dsh-remote-instance.sh <package.tgz> <instance-id> [base-domain] [ssh-target] [--enable-linger]" >&2
  exit 2
fi

package_source=$1
instance_id=$2
base_domain=${3:-dsh.onlyservice.io}
ssh_target=${4:-vps-tencent-tokyo}
linger_option=${5:-}
[ -z "$linger_option" ] || [ "$linger_option" = --enable-linger ] || { echo "invalid linger option" >&2; exit 2; }
dsh_home=${DSH_HOME_TARGET:-"$HOME/.local/dsh_home"}
dsh_bin=${DSH_BIN:-"$HOME/.local/bin/dsh"}
install_root=${DSH_INSTALL_ROOT:-"$HOME/.local/share/dsh-cli"}
profile_dir="$dsh_home/profiles/web"
unit_dir="$HOME/.config/systemd/user"
unit="$unit_dir/dsh-remote-$instance_id.service"
environment_dir="$HOME/.config/dsh-remote"
environment_file="$environment_dir/$instance_id.env"
state_root="$HOME/.local/state/dsh-remote/instance-installs"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="$state_root/$stamp-$instance_id"

sha256_file() {
  openssl dgst -sha256 "$1" | awk '{print $NF}'
}

case "$instance_id" in
  ''|*[!a-z0-9-]*|-*|*-|*--*) echo "invalid instance id" >&2; exit 2 ;;
esac
[ "${#instance_id}" -le 63 ] || { echo "invalid instance id" >&2; exit 2; }
case "$base_domain" in
  ''|*[!a-z0-9.-]*|.*|*.|*..*) echo "invalid base domain" >&2; exit 2 ;;
esac
case "$ssh_target" in
  ''|*[!A-Za-z0-9._@-]*) echo "invalid SSH target" >&2; exit 2 ;;
esac
[ -f "$package_source" ] || { echo "package tarball is missing" >&2; exit 2; }
[ -x "$dsh_bin" ] || { echo "dsh launcher is missing" >&2; exit 2; }
[ -x "$install_root/current/.corepack-bin/pnpm" ] || { echo "managed pnpm shim is missing" >&2; exit 2; }

install -d -m 700 "$backup" "$install_root/packages" "$unit_dir" "$environment_dir"
for name in package.json pnpm-lock.yaml cordis.patch.yml; do
  if [ -f "$profile_dir/$name" ]; then
    cp -p "$profile_dir/$name" "$backup/$name"
  else
    : > "$backup/$name.absent"
  fi
done
if [ -f "$unit" ]; then
  cp -p "$unit" "$backup/unit.service"
else
  : > "$backup/unit.absent"
fi
if systemctl --user is-active --quiet "dsh-remote-$instance_id.service" 2>/dev/null; then unit_was_active=true; else unit_was_active=false; fi
if systemctl --user is-enabled --quiet "dsh-remote-$instance_id.service" 2>/dev/null; then unit_was_enabled=true; else unit_was_enabled=false; fi
if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)" = yes ]; then linger_was_enabled=true; else linger_was_enabled=false; fi
linger_enabled_by_installer=false

digest=$(sha256_file "$package_source")
package_target="$install_root/packages/dsh-remote-$digest.tgz"
package_existed=false
if [ -f "$package_target" ]; then
  [ "$(sha256_file "$package_target")" = "$digest" ] || {
    echo "existing package hash mismatch" >&2
    exit 1
  }
  package_existed=true
else
  install -m 600 "$package_source" "$package_target"
fi

restore() {
  set +e
  systemctl --user stop "dsh-remote-$instance_id.service" >/dev/null 2>&1 || true
  for name in package.json pnpm-lock.yaml cordis.patch.yml; do
    if [ -f "$backup/$name.absent" ]; then
      rm -f "$profile_dir/$name"
    elif [ -f "$backup/$name" ]; then
      cp -p "$backup/$name" "$profile_dir/$name"
    fi
  done
  if [ -f "$backup/unit.absent" ]; then
    rm -f "$unit"
  elif [ -f "$backup/unit.service" ]; then
    cp -p "$backup/unit.service" "$unit"
  fi
  if [ "$package_existed" = false ]; then rm -f "$package_target"; fi
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  if [ "$unit_was_enabled" = true ]; then
    systemctl --user enable "dsh-remote-$instance_id.service" >/dev/null 2>&1 || true
  else
    systemctl --user disable "dsh-remote-$instance_id.service" >/dev/null 2>&1 || true
  fi
  if [ "$unit_was_active" = true ]; then
    systemctl --user restart "dsh-remote-$instance_id.service" >/dev/null 2>&1 || true
  fi
  if [ "$linger_enabled_by_installer" = true ]; then
    sudo -n loginctl disable-linger "$USER" >/dev/null 2>&1 || true
  fi
}
committed=false
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$committed" != true ]; then restore; fi
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

if [ "$linger_was_enabled" != true ]; then
  [ "$linger_option" = --enable-linger ] || {
    echo "user lingering is required; rerun with --enable-linger after authorizing the host lifecycle change" >&2
    exit 1
  }
  sudo -n loginctl enable-linger "$USER"
  [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)" = yes ] || { echo "failed to enable user lingering" >&2; exit 1; }
  linger_enabled_by_installer=true
fi

PATH="$install_root/current/.corepack-bin:$PATH" DSH_HOME="$dsh_home" \
  "$dsh_bin" plugin --profile web add --workspace-root "$package_target"

temporary="$unit.tmp.$$"
cat > "$temporary" <<EOF
[Unit]
Description=DSH Remote instance $instance_id
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$HOME
Environment=PATH=$install_root/current/.corepack-bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=DSH_REMOTE_INSTANCE_ID=$instance_id
Environment=DSH_REMOTE_BASE_DOMAIN=$base_domain
Environment=DSH_REMOTE_SSH_TARGET=$ssh_target
EnvironmentFile=-$environment_file
ExecStart=$dsh_bin web --host 127.0.0.1 --port 3280
Restart=on-failure
RestartSec=3
UMask=0077

[Install]
WantedBy=default.target
EOF
chmod 600 "$temporary"
mv "$temporary" "$unit"
systemctl --user daemon-reload
systemctl --user enable "$unit" >/dev/null
systemctl --user restart "dsh-remote-$instance_id.service"
attempt=0
http_code=000
while [ "$attempt" -lt 60 ]; do
  http_code=$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3280/ || true)
  [ "$http_code" = 200 ] && break
  attempt=$((attempt + 1))
  sleep 0.5
done
[ "$http_code" = 200 ] || { echo "DSH Web readiness failed" >&2; exit 1; }
committed=true
trap - EXIT HUP INT TERM

cat > "$backup/receipt.env" <<EOF
schema=dsh-remote-instance-receipt-v2
status=committed
instance_id=$instance_id
linger_was_enabled=$linger_was_enabled
linger_enabled_by_installer=$linger_enabled_by_installer
unit_was_enabled=$unit_was_enabled
unit_was_active=$unit_was_active
package_sha256=$digest
EOF
chmod 600 "$backup/receipt.env"

printf 'instance=%s\npackage_sha256=%s\nunit=%s\nenvironment_file=%s\nbackup=%s\n' \
  "$instance_id" "$digest" "$unit" "$environment_file" "$backup"
