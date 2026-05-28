#!/usr/bin/env bash
# launch.sh — start a single mlx_lm.server serving the deployed
# thinking-adversary base, zero-shot (no adapter).
#
# This is the lightweight, single-sidecar alternative to the multi-
# adapter SFT stack in mlx-lm-multi/. The motivating observation:
# the SFT +adversary lane has plateaued and Qwen3.5-27B + thinking,
# run zero-shot, outperforms it on substantive engagement under a
# precision-on-real-bugs metric. Default model location is
# $HOME/models/Qwen3.5-27B-4bit; operators with the model elsewhere
# override via MODEL_DIR.
#
# Usage:
#   ./launch.sh                       # start with defaults
#   ./launch.sh stop                  # stop running instance
#
# All knobs are env-var-overridable (see the definitions below):
#   MAX_TOKENS=4096 ...           # tighter generation budget
#   PROMPT_CACHE_BYTES=536870912  # 512 MiB cache
#   PORT=18081 ...                # different port
#   MODEL_DIR=/path/to/other-model ...  # different base
#
# !!! THE COMMITTED DEFAULTS ARE TUNED ON A LARGE APPLE SILICON BOX. !!!
# Specifically: 128 GB unified, 40 GPU cores, macOS 26.5. Smaller
# Apple Silicon (M2 Max class and below) will likely need lower
# --max-tokens and --prompt-cache-bytes to stay under Metal's
# per-process resource limit. We have observed
# `[metal::malloc] Resource limit (499000) exceeded` at
# --max-tokens 16384 even on the large box during tuning. If you see
# that error or empty reviews on a smaller box, dial these down via
# the env vars above before suspecting the model. A future cross-host
# fix (CLI --profile m5|m2|... switches or sysctl-based auto-detect)
# is parked until we have a second-host data point to anchor against.
#
# Why the explicit flags:
#   --max-tokens 8192     mlx_lm.server defaults to 512, which truncates
#                         the thinking budget before any review body is
#                         emitted. And: this is an *ongoing tuning knob*,
#                         not a set-and-forget default. Re-tune when the
#                         corpus or prompt shape changes meaningfully.
#   --prompt-cache-size 4
#   --prompt-cache-bytes 1G
#                         Smaller than the multi-adapter stack's defaults
#                         (16 / 2 GiB). The combination of long thinking
#                         traces + large prompt caches can exhaust
#                         Metal's per-process resource limit; a smaller
#                         cache reduces total resource pressure with no
#                         measurable hit to throughput at modest request
#                         volume.
#
# Ports:
#   :18080  the sole sidecar this stack uses. Matches pi's local-mlx
#           provider baseUrl. There is no proxy and no per-adapter
#           sidecar — zero-shot only.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDS_DIR="$SCRIPT_DIR/pids"
LOG_DIR="$SCRIPT_DIR/logs"
PY_ENV="${PY_ENV:-$HOME/.pi/agent/venv}"
MODEL_DIR="${MODEL_DIR:-$HOME/models/Qwen3.5-27B-4bit}"
PORT="${PORT:-18080}"
HOST="${HOST:-127.0.0.1}"
MAX_TOKENS="${MAX_TOKENS:-8192}"
PROMPT_CACHE_SIZE="${PROMPT_CACHE_SIZE:-4}"
PROMPT_CACHE_BYTES="${PROMPT_CACHE_BYTES:-1073741824}"

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

[[ -d "$MODEL_DIR" ]] || { echo "model dir missing: $MODEL_DIR (override via MODEL_DIR=...)" >&2; exit 1; }
[[ -x "$PY_ENV/bin/mlx_lm.server" ]] || { echo "venv mlx_lm.server missing: $PY_ENV/bin/mlx_lm.server" >&2; exit 1; }

stop_existing

# shellcheck disable=SC1091
source "$PY_ENV/bin/activate"

echo "==> thinking-adversary  port=$PORT  model=$MODEL_DIR"
nohup mlx_lm.server \
    --model "$MODEL_DIR" \
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
