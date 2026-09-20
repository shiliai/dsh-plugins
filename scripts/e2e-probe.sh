#!/bin/bash
# e2e-probe.sh — HTTP-level e2e probe for a dsh web host's attachment upload
# pipeline. Exercises the paths that matter for plugin changes (issue #109
# class of bugs): multi-megabyte base64 uploads, canonical-base64 validation,
# and the delete endpoint. Run it against the dev sandbox after every build:

#   scripts/e2e-probe.sh --base http://127.0.0.1:5280

# Exit status is non-zero if any probe fails.
set -euo pipefail

BASE="http://127.0.0.1:5280"
while [ $# -gt 0 ]; do
  case "$1" in
    --base) [ $# -ge 2 ] || { echo "e2e-probe.sh: --base needs a value" >&2; exit 2; }
      BASE="$2"; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "e2e-probe.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done

API="$BASE/dsh-file-attachment/api"
TMP="$(mktemp -d /tmp/dsh-e2e-probe.XXXXXX)"
trap 'rm -rf "$TMP"; exit 130' INT TERM
trap 'rm -rf "$TMP"' EXIT
FAIL=0

node - "$TMP" <<'EOF'
const fs = require('fs')
const [dir] = process.argv.slice(2)
// ~4MB file -> 5.59M base64 chars: above the old regex stack-overflow bound.
const big = Buffer.alloc(4_193_280).toString('base64')
fs.writeFileSync(`${dir}/big.json`, JSON.stringify({ files: [{ name: 'big.png', mediaType: 'image/png', data: big }], existingFileIds: [] }))
const corrupt = JSON.parse(fs.readFileSync(`${dir}/big.json`, 'utf8'))
corrupt.files[0].name = 'corrupt.png'
corrupt.files[0].data = big.slice(0, -2) + '@@'
fs.writeFileSync(`${dir}/corrupt.json`, JSON.stringify(corrupt))
const midpad = JSON.parse(fs.readFileSync(`${dir}/big.json`, 'utf8'))
midpad.files[0].name = 'midpad.png'
midpad.files[0].data = big.slice(0, -8) + 'AA==AA=='
fs.writeFileSync(`${dir}/midpad.json`, JSON.stringify(midpad))
fs.writeFileSync(`${dir}/small.json`, JSON.stringify({ files: [{ name: 'tiny.png', mediaType: 'image/png', data: 'iVBORw0KGgo=' }], existingFileIds: [] }))
fs.writeFileSync(`${dir}/malformed.json`, JSON.stringify({ files: [{ name: 'bad.png', mediaType: 'image/png', data: 'not base64' }], existingFileIds: [] }))
EOF

check() { # <name> <expected-status> <file> [expected-json-substring]
  local name="$1" want="$2" file="$3" sub="${4:-}"
  local got body
  # '|| true': a transport failure must be reported as a FAIL line below,
  # not kill the whole probe run via 'set -e'.
  rm -f "$TMP/resp.json"
  got="$(curl -s -m 30 -o "$TMP/resp.json" -w '%{http_code}' -X POST "$API/upload" \
    -H 'Content-Type: application/json' -H "Origin: $BASE" --data-binary "@$file" || true)"
  body="$(cat "$TMP/resp.json" 2>/dev/null || true)"
  if [ "$got" = "$want" ] && { [ -z "$sub" ] || case "$body" in *"$sub"*) true;; *) false;; esac; }; then
    echo "PASS  $name (status=$got)"
  else
    echo "FAIL  $name (want $want${sub:+, body containing '$sub'}; got $got: $(echo "$body" | head -c 120))"
    FAIL=1
  fi
  if [ "$got" = "201" ]; then
    node -e "
      const fs = require('fs')
      const r = JSON.parse(fs.readFileSync('$TMP/resp.json', 'utf8'))
      if (r.files?.[0]?.fileId) fs.writeFileSync('$TMP/fileId', r.files[0].fileId)
    " 2>/dev/null || true
  fi
}

echo "e2e-probe.sh: probing $API"
# Liveness: the limits endpoint carries no auth fence.
got="$(curl -s -m 10 -o "$TMP/limits.json" -w '%{http_code}' "$API/limits" || true)"
if [ "$got" = "200" ]; then echo "PASS  GET /limits (status=200)"; else echo "FAIL  GET /limits (got $got)"; FAIL=1; fi

check "small upload"                 201 "$TMP/small.json"    '"bytes":8'
check "~4MB upload (issue #109)"     201 "$TMP/big.json"      '"bytes":4193280'
check "huge payload, invalid char"   400 "$TMP/corrupt.json"  'INVALID_BASE64'
check "huge payload, mid padding"    400 "$TMP/midpad.json"   'INVALID_BASE64'
check "small malformed base64"       400 "$TMP/malformed.json" 'INVALID_BASE64'

if [ -f "$TMP/fileId" ]; then
  got="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X DELETE "$API/file" \
    -H 'Content-Type: application/json' -H "Origin: $BASE" -d "{\"fileId\":\"$(cat "$TMP/fileId")\"}" || true)"
  if [ "$got" = "204" ]; then echo "PASS  delete uploaded probe file (status=204)"; else echo "FAIL  delete (got $got)"; FAIL=1; fi
fi

if [ "$FAIL" != 0 ]; then
  echo "e2e-probe.sh: FAILURES above." >&2
  exit 1
fi
echo "e2e-probe.sh: all probes passed."
