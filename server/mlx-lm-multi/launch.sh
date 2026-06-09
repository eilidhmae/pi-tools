#!/usr/bin/env bash
# launch.sh — start the base mlx_lm.server, one mlx_lm.server per adapter
# listed in adapters.conf, and the routing proxy on :18080.
#
# Idempotent: existing pids in pids/ are killed before relaunch.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/serverlib.sh
. "$SCRIPT_DIR/../lib/serverlib.sh"
PIDS_DIR="$SCRIPT_DIR/pids"
LOG_DIR="$SCRIPT_DIR/logs"
CONF="$SCRIPT_DIR/adapters.conf"
BASE_MODEL_DIR="${BASE_MODEL_DIR:-$HOME/models/Qwen3-Coder-30B-A3B-Instruct-4bit}"
BASE_PORT="${BASE_PORT:-18090}"
PROXY_PORT="${PROXY_PORT:-18080}"
# Bind address for the mlx servers AND the proxy. Default 127.0.0.1 (loopback
# only); set HOST=0.0.0.0 to expose on all interfaces, e.g. so an Apple Container
# guest can reach them via the host bridge (192.168.64.1).
HOST="${HOST:-127.0.0.1}"
require_bindable_host "$HOST" || exit 1
PY_ENV="${PY_ENV:-$HOME/.pi/agent/venv}"
PROMPT_CACHE_SIZE="${PI_PROMPT_CACHE_SIZE:-16}"
PROMPT_CACHE_BYTES="${PI_PROMPT_CACHE_BYTES:-2147483648}"
# Generation ceiling for the base + every adapter server. mlx_lm.server's
# built-in default is 512, which truncates long answers; floor it generously.
MAX_TOKENS="${MAX_TOKENS:-32768}"

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
    --host "$HOST" \
    --max-tokens "$MAX_TOKENS" \
    --prompt-cache-size "$PROMPT_CACHE_SIZE" \
    --prompt-cache-bytes "$PROMPT_CACHE_BYTES" \
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
            --host "$HOST" \
            --max-tokens "$MAX_TOKENS" \
            --prompt-cache-size "$PROMPT_CACHE_SIZE" \
            --prompt-cache-bytes "$PROMPT_CACHE_BYTES" \
            >"$LOG_DIR/$suffix.log" 2>&1 &
        echo $! > "$PIDS_DIR/$suffix.pid"
        ROUTES+=("$suffix:$port")
    done < "$CONF"
fi

# Hand the routing table to the proxy via env var
export PI_BASE_MODEL_DIR="$BASE_MODEL_DIR"
export PI_PROXY_ROUTES="$(IFS=, ; echo "${ROUTES[*]}")"
export PI_PROXY_PORT="$PROXY_PORT"
export PI_PROXY_HOST="$HOST"

echo "==> proxy  port=$PROXY_PORT  routes=$PI_PROXY_ROUTES"
nohup python "$SCRIPT_DIR/proxy.py" \
    >"$LOG_DIR/proxy.log" 2>&1 &
echo $! > "$PIDS_DIR/proxy.pid"

if wait_listening "$PROXY_PORT" "$(cat "$PIDS_DIR/proxy.pid")" "$LOG_DIR/proxy.log"; then
  echo "up  proxy listening=$HOST:$PROXY_PORT"
else
  exit 1
fi
echo
echo "Logs:    $LOG_DIR"
echo "Pids:    $PIDS_DIR"
echo "Health:  curl -sS http://localhost:$PROXY_PORT/healthz | jq ."
