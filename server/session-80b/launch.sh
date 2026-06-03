#!/usr/bin/env bash
# launch.sh — start a single mlx_lm.server serving the 80B agentic
# session model (Qwen3-Coder-Next-80B-A3B, 8-bit), zero-shot.
#
# This is a SEPARATE track from thinking-adversary/ (the 27B on :18080).
# It runs on its own port with its own pid/log so the two can coexist:
# the 80B drives interactive sessions while the 27B serves
# workers/researchers/adversaries on demand. They are NOT mutually
# exclusive with each other; the 80B IS mutually exclusive with the
# heavy SFT / extra-models contrast tracks (memory budget — see below).
#
# Unlike thinking-adversary/launch.sh this accepts an HF repo id for
# MODEL (resolved from the local HF cache under HF_HOME) so the 83 GB
# weights need not be re-flattened into a second copy.
#
# Usage:
#   ./launch.sh                       # start with defaults
#   ./launch.sh stop                  # stop running instance
#
# Env knobs:
#   MODEL=<repo-id|/flat/dir> ...     # default: inferencerlabs/Qwen3-Coder-Next-MLX-9bit
#   PORT=18130 ...                    # matches pi's local-mlx-80b provider
#   MAX_TOKENS=8192 ...               # generation budget
#   PROMPT_CACHE_BYTES / PROMPT_CACHE_SIZE
#
# Memory: the 80B is ~83 GB resident (8-bit). Its KV cache is tiny
# (qwen3_next hybrid linear attention; ~1 GB observed) so context length
# barely moves memory. But 83 GB + the 27B (~15 GB) + apps approaches the
# 128 GB ceiling: do NOT also run the SFT (mlx-lm-multi) or extra-models
# tracks while this is up. One heavy track at a time.
#
# Tool calls: this model emits Qwen3-Coder XML tool calls
# (<tool_call>\n<function=...>). Requires the venv mlx-lm with the
# tool-parser-selection fix (tokenizer_utils._resolve_tool_parser_type),
# otherwise the model's tokenizer_config mislabel ("json_tools") makes
# the server json.loads() the XML and silently drop every tool call.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDS_DIR="$SCRIPT_DIR/pids"
LOG_DIR="$SCRIPT_DIR/logs"
PY_ENV="${PY_ENV:-$HOME/.pi/agent/venv}"
MODEL="${MODEL:-inferencerlabs/Qwen3-Coder-Next-MLX-9bit}"
PORT="${PORT:-18130}"
HOST="${HOST:-127.0.0.1}"
MAX_TOKENS="${MAX_TOKENS:-8192}"
PROMPT_CACHE_SIZE="${PROMPT_CACHE_SIZE:-4}"
PROMPT_CACHE_BYTES="${PROMPT_CACHE_BYTES:-1073741824}"   # 1 GiB

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

# Resolve the model. A flat local dir must carry a top-level config.json
# (mlx_lm.server loads it lazily in a worker thread that otherwise dies with
# FileNotFoundError, hanging every request). An HF repo id (org/name) is passed
# through and resolved from the HF cache under HF_HOME; warn if it isn't cached
# yet rather than silently triggering an 83 GB download mid-launch.
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

echo "==> session-80b  port=$PORT  model=$MODEL"
nohup mlx_lm.server \
    --model "$MODEL" \
    --port "$PORT" \
    --host "$HOST" \
    --max-tokens "$MAX_TOKENS" \
    --prompt-cache-size "$PROMPT_CACHE_SIZE" \
    --prompt-cache-bytes "$PROMPT_CACHE_BYTES" \
    > "$LOGFILE" 2>&1 &
echo $! > "$PIDFILE"
sleep 2

if kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "up (pid $(cat "$PIDFILE"))  log=$LOGFILE"
else
  echo "FAILED to start; tail $LOGFILE" >&2
  exit 1
fi
