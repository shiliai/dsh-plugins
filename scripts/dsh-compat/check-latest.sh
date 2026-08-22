#!/bin/sh
set -eu

umask 077

script_path=$0
if [ -L "$script_path" ]; then
  link=$(readlink "$script_path")
  case "$link" in
    /*) script_path=$link ;;
    *) script_path=$(dirname -- "$script_path")/$link ;;
  esac
fi
script_dir=$(CDPATH= cd -- "$(dirname -- "$script_path")" && pwd)
probe="$script_dir/probe.mjs"
[ "$#" -eq 0 ] || {
  echo "usage: dsh-compat-check" >&2
  exit 2
}
root=${DSH_COMPAT_ROOT:-"$HOME/.local/state/dsh-compat"}
web_port=${DSH_COMPAT_WEB_PORT:-3380}
gateway_port=${DSH_COMPAT_GATEWAY_PORT:-30321}
dsh_spec=${DSH_COMPAT_DSH_SPEC:-latest}
remote_repo=${DSH_COMPAT_REMOTE_REPO:-https://github.com/shiliai/dsh-plugins.git}
remote_ref=${DSH_COMPAT_REMOTE_REF:-refs/heads/main}
pnpm_version=${DSH_COMPAT_PNPM_VERSION:-11.19.0}
run_id=$(date -u +%Y%m%dT%H%M%SZ)-$$
run_dir="$root/runs/$run_id"
work_dir="$run_dir/work"
report="$run_dir/summary.json"
log="$run_dir/check.log"
stage=initialize
dsh_version=
remote_commit=
remote_version=
web_pid=
result=failed

mkdir -p "$run_dir" "$work_dir" "$root/runs"
chmod 700 "$root" "$root/runs" "$run_dir" "$work_dir"
exec 9>"$root/check.lock"
if ! flock -n 9; then
  echo "dsh-compat: another compatibility check is active" >&2
  exit 1
fi

write_summary() {
  DSH_COMPAT_RESULT="$result" \
  DSH_COMPAT_STAGE="$stage" \
  DSH_COMPAT_RUN_ID="$run_id" \
  DSH_COMPAT_DSH_VERSION="$dsh_version" \
  DSH_COMPAT_REMOTE_VERSION="$remote_version" \
  DSH_COMPAT_REMOTE_COMMIT="$remote_commit" \
  DSH_COMPAT_WEB_PORT="$web_port" \
  DSH_COMPAT_GATEWAY_PORT="$gateway_port" \
  DSH_COMPAT_LOG="$log" \
    node "$probe" summary "$report" >/dev/null 2>&1 || true
}

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ -n "$web_pid" ] && kill -0 "$web_pid" 2>/dev/null; then
    kill "$web_pid" 2>/dev/null || true
    wait "$web_pid" 2>/dev/null || true
  fi
  case "$work_dir" in
    "$root"/runs/*/work) rm -rf -- "$work_dir" ;;
    *) echo "dsh-compat: refused unsafe work cleanup: $work_dir" >&2 ;;
  esac
  if [ "$status" -eq 0 ]; then result=passed; else result=failed; fi
  write_summary
  temporary_link="$root/latest.tmp.$$"
  ln -s "runs/$run_id" "$temporary_link"
  mv -Tf "$temporary_link" "$root/latest"
  printf 'dsh-compat: result=%s stage=%s report=%s\n' "$result" "$stage" "$report"
  if [ "$status" -ne 0 ]; then
    printf 'dsh-compat: last log lines:\n' >&2
    tail -30 "$log" >&2 || true
  fi
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

step() {
  stage=$1
  write_summary
  printf 'dsh-compat: %s\n' "$stage"
}

step preflight
for command in node npm git corepack curl flock sha256sum; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "missing required command: $command" >>"$log"
    exit 1
  }
done
node "$probe" assert-isolated "$web_port" "$gateway_port" >>"$log" 2>&1
node "$probe" port-free "$web_port" >>"$log" 2>&1
node "$probe" port-free "$gateway_port" >>"$log" 2>&1
node "$probe" snapshot 3280 29321 "$run_dir/production-before.json" >>"$log" 2>&1

step resolve-latest
dsh_version=$(npm view "@deepseek-ai/dsh@$dsh_spec" version 2>>"$log" | tail -1)
remote_commit=$(git ls-remote "$remote_repo" "$remote_ref" 2>>"$log" | awk 'NR == 1 { print $1 }')
node "$probe" validate-version "$dsh_version" >>"$log" 2>&1
node "$probe" validate-commit "$remote_commit" >>"$log" 2>&1

step install-dsh
runtime="$work_dir/runtime"
node "$probe" init-runtime "$runtime" "$dsh_version" "$pnpm_version" >>"$log" 2>&1
(
  cd "$runtime"
  corepack pnpm install --frozen-lockfile=false >>"$log" 2>&1
  mkdir -p .corepack-bin
  corepack enable --install-directory "$runtime/.corepack-bin" pnpm >>"$log" 2>&1
)
dsh_bin="$runtime/node_modules/@deepseek-ai/dsh/lib/bin.js"
[ -f "$dsh_bin" ] || { echo "installed DSH entry point is missing" >>"$log"; exit 1; }
observed=$(node "$dsh_bin" --version 2>>"$log")
[ "$observed" = "$dsh_version" ] || { echo "expected DSH $dsh_version, observed $observed" >>"$log"; exit 1; }

step build-dsh-remote
source_dir="$work_dir/dsh-plugins"
git init -q "$source_dir"
git -C "$source_dir" remote add origin "$remote_repo"
git -C "$source_dir" fetch --depth=1 origin "$remote_commit" >>"$log" 2>&1
git -C "$source_dir" checkout -q --detach FETCH_HEAD
[ "$(git -C "$source_dir" rev-parse HEAD)" = "$remote_commit" ] || exit 1
remote_manifest="$source_dir/plugins/dsh-remote/package.json"
remote_version=$(node -p "require(process.argv[1]).version" "$remote_manifest")
(
  cd "$source_dir"
  PATH="$runtime/.corepack-bin:$PATH"
  export PATH
  corepack pnpm --filter @dsh-plugins/dsh-remote... install --frozen-lockfile >>"$log" 2>&1
  mkdir -p "$work_dir/artifacts"
  corepack pnpm --dir plugins/dsh-remote pack --pack-destination "$work_dir/artifacts" >>"$log" 2>&1
)
archive=$(find "$work_dir/artifacts" -maxdepth 1 -type f -name '*.tgz' -print | head -1)
[ -n "$archive" ] && [ -f "$archive" ] || { echo "dsh-remote package was not created" >>"$log"; exit 1; }
sha256sum "$archive" >"$run_dir/dsh-remote-package.sha256"

step peer-observation
node "$probe" peers "$runtime" "$remote_manifest" "$run_dir/peer-compatibility.json" >>"$log" 2>&1

step install-plugin
dsh_home="$work_dir/dsh-home"
mkdir -p "$dsh_home"
PATH="$runtime/.corepack-bin:$PATH" DSH_HOME="$dsh_home" \
  node "$dsh_bin" plugin --profile web add --workspace-root "$archive" >>"$log" 2>&1
PATH="$runtime/.corepack-bin:$PATH" DSH_HOME="$dsh_home" \
  node "$dsh_bin" --profile web --dump-config >>"$run_dir/web-config.yaml" 2>>"$log"

step start-isolated-runtime
state_file="$work_dir/dsh-remote-state.json"
web_log="$run_dir/web.log"
PATH="$runtime/.corepack-bin:$PATH" \
DSH_HOME="$dsh_home" \
DSH_REMOTE_MODE=host \
DSH_REMOTE_SSH_COMPATIBILITY=false \
DSH_REMOTE_INSTANCE_ID=compat-check \
DSH_REMOTE_ORIGIN=https://compat.invalid \
DSH_REMOTE_GATEWAY_PORT="$gateway_port" \
DSH_REMOTE_AGENT_SOCKET_PATH="$work_dir/no-agent.sock" \
DSH_REMOTE_STATE_FILE="$state_file" \
  node "$dsh_bin" web --host 127.0.0.1 --port "$web_port" >"$web_log" 2>&1 &
web_pid=$!
node "$probe" wait-ready "$web_port" "$gateway_port" "$web_pid" >>"$log" 2>&1

step compatibility-probes
node "$probe" runtime "$runtime" "$web_port" "$gateway_port" "$web_pid" "$state_file" "$run_dir/runtime-probes.json" >>"$log" 2>&1

step verify-isolation
node "$probe" snapshot 3280 29321 "$run_dir/production-after.json" >>"$log" 2>&1
node "$probe" compare-snapshots "$run_dir/production-before.json" "$run_dir/production-after.json" >>"$log" 2>&1

step complete
exit 0
