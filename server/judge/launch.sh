#!/usr/bin/env bash
# launch.sh — start a single mlx_lm.server serving the eval JUDGE model
# (Qwen3-Coder-30B-A3B-Instruct, 4-bit), bare and proxy-free.
#
# This is the scoring backend for the eval-v2 GT-recall judge (judge.py,
# the local, Claude-free scorer). It is a SEPARATE track from sft: the sft
# stack also serves a 30B base on :18090 but bundles a routing proxy on
# :18080 plus the per-adapter ports. The judge needs only the bare base on
# :18090, so it coexists with the thinking track (:18080) and is mutually
# exclusive with sft (both bind :18090).
#
# Usage:
#   ./launch.sh                       # start with defaults
#   ./launch.sh stop                  # stop running instance
#
# Env knobs:
#   MODEL=<dir|repo-id> ...           # default: $HOME/models/Qwen3-Coder-30B-A3B-Instruct-4bit
#   PORT=18090 ...                    # matches judge.py's default --port
#   HOST=127.0.0.1 ...                # set 0.0.0.0 for container/guest access
#   MAX_TOKENS=2048 ...               # server cap; judge.py sends its own
#                                       (short) max_tokens per scoring call
#   PROMPT_CACHE_BYTES / PROMPT_CACHE_SIZE
#
# The judge does plain chat-completions scoring (no tool calls, no <think>
# runaway to worry about), so no tool-parser or thinking-budget caveats apply.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/serverlib.sh
. "$SCRIPT_DIR/../lib/serverlib.sh"
PIDS_DIR="$SCRIPT_DIR/pids"
LOG_DIR="$SCRIPT_DIR/logs"
PY_ENV="${PY_ENV:-$HOME/.pi/agent/venv}"
MODEL="${MODEL:-$HOME/models/Qwen3-Coder-30B-A3B-Instruct-4bit}"
PORT="${PORT:-18090}"
HOST="${HOST:-127.0.0.1}"
MAX_TOKENS="${MAX_TOKENS:-2048}"
PROMPT_CACHE_SIZE="${PROMPT_CACHE_SIZE:-16}"
PROMPT_CACHE_BYTES="${PROMPT_CACHE_BYTES:-2147483648}"   # 2 GiB

mkdir -p "$PIDS_DIR" "$LOG_DIR"
PIDFILE="$PIDS_DIR/server.pid"
LOGFILE="$LOG_DIR/server.log"

stop_existing() {
  [[ -f "$PIDFILE" ]] || return 0
  local pid; pid="$(cat "$PIDFILE")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
}

case "${1:-up}" in
  stop|down)
    stop_existing
    echo "stopped"
    exit 0
    ;;
  up|start|"")
    ;;
  *)
    echo "unknown subcommand: $1 (try 'up' or 'stop')" >&2
    exit 2
    ;;
esac

require_bindable_host "$HOST" || exit 1

# Resolve the model. A flat local dir must carry a top-level config.json
# (mlx_lm.server loads it lazily in a worker thread that otherwise dies with
# FileNotFoundError, hanging every request). An HF repo id (org/name) is passed
# through and resolved from the HF cache under HF_HOME; warn if it isn't cached.
if [[ -d "$MODEL" ]]; then
    if [[ ! -f "$MODEL/config.json" ]]; then
        echo "model dir has no top-level config.json: $MODEL" >&2
        compgen -G "$MODEL/snapshots/*/config.json" >/dev/null 2>&1 && \
            echo "  -> looks like an HF cache tree; pass the repo id instead, or re-download with --local-dir" >&2
        exit 1
    fi
elif [[ "$MODEL" == */* ]]; then
    cache_root="${HF_HOME:-$HOME/.cache/huggingface}"
    cache_name="models--${MODEL//\//--}"
    if ! compgen -G "$cache_root/hub/$cache_name/snapshots/*/config.json" >/dev/null 2>&1 \
       && ! compgen -G "$cache_root/$cache_name/snapshots/*/config.json" >/dev/null 2>&1; then
        echo "warning: '$MODEL' not found in HF cache ($cache_root); mlx_lm will try to download it" >&2
    fi
else
    echo "MODEL is neither a directory nor an org/name repo id: $MODEL" >&2
    exit 1
fi
[[ -x "$PY_ENV/bin/mlx_lm.server" ]] || { echo "venv mlx_lm.server missing: $PY_ENV/bin/mlx_lm.server" >&2; exit 1; }

stop_existing

# shellcheck disable=SC1091
source "$PY_ENV/bin/activate"

echo "==> judge  port=$PORT  model=$MODEL"
nohup mlx_lm.server \
    --model "$MODEL" \
    --port "$PORT" \
    --host "$HOST" \
    --max-tokens "$MAX_TOKENS" \
    --prompt-cache-size "$PROMPT_CACHE_SIZE" \
    --prompt-cache-bytes "$PROMPT_CACHE_BYTES" \
    > "$LOGFILE" 2>&1 &
echo $! > "$PIDFILE"

pid="$(cat "$PIDFILE")"
if wait_listening "$PORT" "$pid" "$LOGFILE"; then
  echo "up (pid $pid)  listening=$HOST:$PORT  log=$LOGFILE"
else
  exit 1
fi
