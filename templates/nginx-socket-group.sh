#!/bin/sh
set -eu

socket_dir=/run/dsh-remote
group_id=$(stat -c %g "$socket_dir")

case "$group_id" in
  ''|*[!0-9]*)
    echo "dsh-remote: invalid socket group id" >&2
    exit 1
    ;;
esac

group_name=$(awk -F: -v gid="$group_id" '$3 == gid { print $1; exit }' /etc/group)
if [ -z "$group_name" ]; then
  group_name=dsh-remote
  if awk -F: '$1 == "dsh-remote" { found=1 } END { exit !found }' /etc/group; then
    group_name="dsh-remote-$group_id"
  fi
  addgroup -S -g "$group_id" "$group_name"
fi

if ! id -Gn nginx | tr ' ' '\n' | grep -Fqx "$group_name"; then
  addgroup nginx "$group_name"
fi
