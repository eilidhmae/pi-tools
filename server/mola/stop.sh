#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDS_DIR="$SCRIPT_DIR/pids"
shopt -s nullglob
for pidfile in "$PIDS_DIR"/*.pid; do
    pid="$(cat "$pidfile")"
    name="$(basename "$pidfile" .pid)"
    if kill -0 "$pid" 2>/dev/null; then
        echo "stopping $name (pid $pid)"
        kill "$pid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
done
