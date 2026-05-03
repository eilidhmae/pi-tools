#!/usr/bin/env bash
set -euo pipefail
PORT="${PROXY_PORT:-8080}"
URL="http://localhost:$PORT/healthz"
if ! resp="$(curl -sS --max-time 5 "$URL")"; then
    echo "FAIL: $URL unreachable" >&2
    exit 1
fi
echo "$resp" | jq .
echo "$resp" | jq -e '.ok == true' >/dev/null
