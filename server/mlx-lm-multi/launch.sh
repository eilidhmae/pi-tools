#!/usr/bin/env bash
# launch.sh — start the base mlx_lm.server, one mlx_lm.server per adapter
# listed in adapters.conf, and the routing proxy on :8080.
#
# Idempotent: existing pids in pids/ are killed before relaunch.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDS_DIR="$SCRIPT_DIR/pids"
LOG_DIR="$SCRIPT_DIR/logs"
CONF="$SCRIPT_DIR/adapters.conf"
BASE_MODEL_DIR="${BASE_MODEL_DIR:-$HOME/models/qwen3-coder-7b-4bit}"
BASE_PORT="${BASE_PORT:-8090}"
PROXY_PORT="${PROXY_PORT:-8080}"
PY_ENV="${PY_ENV:-$HOME/.pi/agent/venv}"

mkdir -p "$PIDS_DIR" "$LOG_DIR"

# shellcheck disable=SC1091
source "$PY_ENV/bin/activate"

stop_pid() {
    local pidfile="$1"
    [[ -f "$pidfile" ]] || return 0
    local pid
    pid="$(cat "$pidfile")"
    if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        for _ in 1 2 3 4 5; do
            kill -0 "$pid" 2>/dev/null || break
            sleep 0.5
        done
        kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
}

# Stop any prior instances
for pidfile in "$PIDS_DIR"/*.pid; do
    [[ -e "$pidfile" ]] || continue
    stop_pid "$pidfile"
done

# Start base
echo "==> base   port=$BASE_PORT  model=$BASE_MODEL_DIR"
nohup mlx_lm.server \
    --model "$BASE_MODEL_DIR" \
    --port "$BASE_PORT" \
    --host 127.0.0.1 \
    >"$LOG_DIR/base.log" 2>&1 &
echo $! > "$PIDS_DIR/base.pid"

# Build proxy routing table; first row is base
ROUTES=("base:$BASE_PORT")

# Start one server per configured adapter
if [[ -f "$CONF" ]]; then
    while IFS= read -r line; do
        # Strip comments + skip blanks
        line="${line%%#*}"
        line="$(echo "$line" | xargs || true)"
        [[ -z "$line" ]] && continue

        # shellcheck disable=SC2206
        cols=( $line )
        if [[ ${#cols[@]} -ne 3 ]]; then
            echo "!! malformed adapters.conf row, skipping: $line" >&2
            continue
        fi
        suffix="${cols[0]}"
        port="${cols[1]}"
        adapter_path="${cols[2]/#\~/$HOME}"

        if [[ ! -d "$adapter_path" ]]; then
            echo "!! adapter dir not found, skipping $suffix: $adapter_path" >&2
            continue
        fi

        echo "==> $suffix   port=$port  adapter=$adapter_path"
        nohup mlx_lm.server \
            --model "$BASE_MODEL_DIR" \
            --adapter-path "$adapter_path" \
            --port "$port" \
            --host 127.0.0.1 \
            >"$LOG_DIR/$suffix.log" 2>&1 &
        echo $! > "$PIDS_DIR/$suffix.pid"
        ROUTES+=("$suffix:$port")
    done < "$CONF"
fi

# Hand the routing table to the proxy via env var
export PI_BASE_MODEL_DIR="$BASE_MODEL_DIR"
export PI_PROXY_ROUTES="$(IFS=, ; echo "${ROUTES[*]}")"
export PI_PROXY_PORT="$PROXY_PORT"

echo "==> proxy  port=$PROXY_PORT  routes=$PI_PROXY_ROUTES"
nohup python "$SCRIPT_DIR/proxy.py" \
    >"$LOG_DIR/proxy.log" 2>&1 &
echo $! > "$PIDS_DIR/proxy.pid"

sleep 1
echo
echo "Logs:    $LOG_DIR"
echo "Pids:    $PIDS_DIR"
echo "Health:  curl -sS http://localhost:$PROXY_PORT/healthz | jq ."
