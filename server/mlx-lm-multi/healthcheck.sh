#!/usr/bin/env bash
set -euo pipefail
PORT="${PROXY_PORT:-18080}"
URL="http://localhost:$PORT/healthz"

if ! resp="$(curl -sS --max-time 5 "$URL")"; then
    echo "FAIL: $URL unreachable" >&2
    exit 1
fi

ok="$(echo "$resp" | jq -r '.ok')"
track="$(echo "$resp" | jq -r '.track')"
adapters="$(echo "$resp" | jq -c '.adapters')"

if [[ "$ok" != "true" ]]; then
    echo "FAIL  track=$track  adapters=$adapters" >&2
    exit 1
fi

echo "OK    track=$track  adapters=$adapters"
