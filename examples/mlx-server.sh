#!/usr/bin/env bash
#
# mlx-server.sh — reference operator script for running pi-tools' Qwen
# production stack alongside a side-by-side contrast model for
# heterogeneous-quorum review. Example only; not yet wired into
# install.sh. See ~/src/pi-tools/TODO.md for the promotion plan
# (per-workstation config, launchd plist, install.sh integration).
#
# Wraps server/mlx-lm-multi/{launch,stop}.sh (the Qwen production
# track) and additionally manages a second mlx_lm.server on :18100
# for a coding-specialist model of a different family (the reference
# config below uses Codestral-22B; swap to whichever model you want
# by editing CODESTRAL_* below).
#
# The Qwen proxy.py is hardcoded to a single base id, so a different-
# family model can't slot into it; the contrast server runs as its
# own mlx_lm.server process and is exposed to pi as a sibling
# provider (suggested name `local-mlx-codestral`) in models.json.
#
# Sanity-checks that the runtime venv resolves to the patched mlx-lm
# checkout (relevant only if you're running the open patch from
# https://github.com/ml-explore/mlx-lm/pull/1277; harmless otherwise).
#
# Usage:
#   ./mlx-server.sh up                  # start everything
#   ./mlx-server.sh up qwen|codestral   # start one track
#   ./mlx-server.sh down                # stop everything
#   ./mlx-server.sh down qwen|codestral # stop one track
#   ./mlx-server.sh status              # listeners + /healthz + venv check
#   ./mlx-server.sh logs [base|codestral]
#                                       # tail the chosen log (default: base)
#   ./mlx-server.sh help                # this message
#
# Ports:
#   :18080  routing proxy (proxy.py)         — pi talks to this for Qwen
#   :18090  base mlx_lm.server (Qwen)        — backend for the proxy
#   :18100  contrast model (e.g. Codestral)  — pi talks to this directly

set -euo pipefail

VENV="$HOME/.pi/agent/venv"
VENV_PY="$VENV/bin/python"
MLX_SERVER_BIN="$VENV/bin/mlx_lm.server"
PI_MULTI="$HOME/src/pi-tools/server/mlx-lm-multi"
LAUNCH="$PI_MULTI/launch.sh"
STOP="$PI_MULTI/stop.sh"
BASE_LOG="$PI_MULTI/logs/base.log"
PROXY_URL="http://localhost:18080"
EXPECTED_MLX_PATH="$HOME/src/mlx-lm/mlx_lm/__init__.py"

# Contrast model for heterogeneous quorum. Currently Codestral-22B
# (Mistral lineage); chosen over Codestral-Coder-V2-Lite after V2-Lite
# misread the F1 diff during first-light review (see DECISIONS).
CODESTRAL_PORT=18100
CODESTRAL_MODEL_GLOB="$HOME/.cache/huggingface/hub/models--mlx-community--Codestral-22B-v0.1-4bit/snapshots/*/"
CODESTRAL_RUNTIME="$HOME/src/pi-tools/server/extra-models"
CODESTRAL_LOG="$CODESTRAL_RUNTIME/logs/codestral.log"
CODESTRAL_PID="$CODESTRAL_RUNTIME/pids/codestral.pid"
CODESTRAL_URL="http://localhost:$CODESTRAL_PORT"

BOLD=$'\033[1m'; YEL=$'\033[33m'; RED=$'\033[31m'; GRN=$'\033[32m'; RST=$'\033[0m'

die() { echo "${RED}error:${RST} $*" >&2; exit 1; }
warn() { echo "${YEL}warn:${RST} $*" >&2; }
info() { echo "$*"; }

require_paths() {
  [[ -d "$VENV" ]]      || die "venv missing: $VENV (run pi-tools install.sh first)"
  [[ -x "$VENV_PY" ]]   || die "venv python missing: $VENV_PY"
  [[ -x "$LAUNCH" ]]    || die "launch.sh missing: $LAUNCH"
  [[ -x "$STOP" ]]      || die "stop.sh missing: $STOP"
}

require_codestral_paths() {
  [[ -x "$MLX_SERVER_BIN" ]] || die "mlx_lm.server missing: $MLX_SERVER_BIN"
  # shellcheck disable=SC2206
  local snaps=( $CODESTRAL_MODEL_GLOB )
  [[ -d "${snaps[0]:-/nonexistent}" ]] \
    || die "Codestral snapshot dir not found; run \`hf download mlx-community/Codestral-Coder-V2-Lite-Instruct-4bit-mlx\`"
}

check_patched_build() {
  local resolved
  if ! resolved=$("$VENV_PY" -c 'import mlx_lm; print(mlx_lm.__file__)' 2>/dev/null); then
    return 2
  fi
  [[ "$resolved" == "$EXPECTED_MLX_PATH" ]]
}

warn_if_not_patched() {
  case "$(check_patched_build; echo $?)" in
    0) info "${GRN}venv mlx-lm:${RST} patched (editable from ~/src/mlx-lm)" ;;
    1) warn "venv mlx-lm is the ${BOLD}stock${RST} build, not the patched one."
       warn "  Phase-3 install.sh-shape reviews will silently route to message.reasoning"
       warn "  and pi will see empty output. To restore the patch:"
       warn "    uv pip install --python $VENV_PY -e ~/src/mlx-lm"
       warn "    $0 up" ;;
    2) die "mlx_lm not importable from the venv at all — venv is broken." ;;
  esac
}

qwen_up() {
  info "${BOLD}>>> qwen track${RST}"
  "$LAUNCH"
}

qwen_down() {
  info "${BOLD}>>> qwen track${RST}"
  "$STOP"
}

codestral_pid_alive() {
  [[ -f "$CODESTRAL_PID" ]] && kill -0 "$(cat "$CODESTRAL_PID")" 2>/dev/null
}

codestral_up() {
  require_codestral_paths
  info "${BOLD}>>> codestral track${RST}"
  mkdir -p "$(dirname "$CODESTRAL_LOG")" "$(dirname "$CODESTRAL_PID")"

  if codestral_pid_alive; then
    info "  already running (pid $(cat "$CODESTRAL_PID")); stopping first"
    codestral_down_inner
  fi

  # shellcheck disable=SC2206
  local snaps=( $CODESTRAL_MODEL_GLOB )
  local model_dir="${snaps[0]}"

  info "  port=$CODESTRAL_PORT  model=$model_dir"
  nohup "$MLX_SERVER_BIN" \
      --model "$model_dir" \
      --port "$CODESTRAL_PORT" \
      --host 127.0.0.1 \
      --prompt-cache-size 16 \
      --prompt-cache-bytes 2147483648 \
      >"$CODESTRAL_LOG" 2>&1 &
  echo $! > "$CODESTRAL_PID"
  sleep 1
  if codestral_pid_alive; then
    info "  ${GRN}up${RST} (pid $(cat "$CODESTRAL_PID"))"
  else
    die "codestral failed to start; tail $CODESTRAL_LOG"
  fi
}

codestral_down_inner() {
  [[ -f "$CODESTRAL_PID" ]] || return 0
  local pid; pid="$(cat "$CODESTRAL_PID")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$CODESTRAL_PID"
}

codestral_down() {
  info "${BOLD}>>> codestral track${RST}"
  codestral_down_inner
  info "  ${GRN}stopped${RST}"
}

cmd_up() {
  require_paths
  warn_if_not_patched
  info ""
  case "${1:-all}" in
    all)      qwen_up; info ""; codestral_up ;;
    qwen)     qwen_up ;;
    codestral) codestral_up ;;
    *)        die "unknown track: $1 (use: all|qwen|codestral)" ;;
  esac
  info ""
  info "tail logs:    $0 logs [base|codestral]"
  info "check health: $0 status"
}

cmd_down() {
  require_paths
  case "${1:-all}" in
    all)      qwen_down; codestral_down ;;
    qwen)     qwen_down ;;
    codestral) codestral_down ;;
    *)        die "unknown track: $1 (use: all|qwen|codestral)" ;;
  esac
  info "${GRN}stopped${RST}"
}

cmd_status() {
  require_paths
  warn_if_not_patched
  info ""
  info "${BOLD}listeners:${RST}"
  if ! lsof -nP -iTCP:18080 -iTCP:18090 -iTCP:"$CODESTRAL_PORT" -sTCP:LISTEN 2>/dev/null; then
    warn "  no listeners on :18080, :18090, or :$CODESTRAL_PORT"
  fi
  info ""
  info "${BOLD}qwen proxy health:${RST}"
  if curl -sS -m 3 "$PROXY_URL/healthz" 2>/dev/null | jq -C . 2>/dev/null; then
    :
  else
    warn "  proxy at $PROXY_URL not responding"
  fi
  info ""
  info "${BOLD}codestral health:${RST}"
  if codestral_pid_alive; then
    info "  pid $(cat "$CODESTRAL_PID") alive"
  else
    warn "  no codestral pid"
  fi
  if curl -sS -m 3 "$CODESTRAL_URL/v1/models" 2>/dev/null | jq -C '.data[0].id' 2>/dev/null; then
    :
  else
    warn "  $CODESTRAL_URL/v1/models not responding"
  fi
}

cmd_logs() {
  local which="${1:-base}"
  local logfile
  case "$which" in
    base|qwen)    logfile="$BASE_LOG" ;;
    codestral|ds) logfile="$CODESTRAL_LOG" ;;
    *)            die "unknown log: $which (use: base|codestral)" ;;
  esac
  [[ -f "$logfile" ]] || die "no log yet: $logfile"
  info "tailing $logfile (Ctrl-C to exit)"
  exec tail -f "$logfile"
}

cmd_help() {
  sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

case "${1:-help}" in
  up|start)        shift || true; cmd_up "$@" ;;
  down|stop)       shift || true; cmd_down "$@" ;;
  status|health)   cmd_status ;;
  logs|log|tail)   shift || true; cmd_logs "$@" ;;
  help|-h|--help)  cmd_help ;;
  *) die "unknown subcommand: $1 (try '$0 help')" ;;
esac
