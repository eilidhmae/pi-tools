#!/usr/bin/env bash
#
# mlx-server.sh — local mlx_lm.server stack control.
#
# Wraps server/mlx-lm-multi/{launch,stop}.sh (the Qwen production
# track) and additionally manages config-driven side-by-side
# mlx_lm.server processes for cross-family contrast models.
#
# The Qwen proxy.py is hardcoded to a single base id, so a different-
# family contrast model can't slot into it. Each row in
# server/extra-models/config.conf declares a `<short-name> <port>
# <hf-repo-id>` triple; mlx-server.sh starts one mlx_lm.server per
# row, pointed at the named HuggingFace cache snapshot. Operators
# wire a matching `local-mlx-<short-name>` provider in models.json
# (see server/extra-models/README.md for the snippet).
#
# Usage:
#   ./mlx-server.sh up                  # start qwen + all configured extras
#   ./mlx-server.sh up qwen|<name>      # start one track
#   ./mlx-server.sh down                # stop everything
#   ./mlx-server.sh down qwen|<name>    # stop one track
#   ./mlx-server.sh status              # listeners + /healthz + venv check
#   ./mlx-server.sh logs [base|<name>]  # tail the chosen log (default: base)
#   ./mlx-server.sh list                # list configured tracks
#   ./mlx-server.sh help                # this message
#
# Ports:
#   :18080  routing proxy (proxy.py)         — pi talks to this for Qwen
#   :18090  base mlx_lm.server (Qwen)        — backend for the proxy
#   :18100+ contrast servers (one per row in extra-models/config.conf)
#
# Environment overrides:
#   PI_VENV               (default $HOME/.pi/agent/venv) — python venv
#   PI_EXPECTED_MLX_PATH  (default empty)               — if set, verify
#                                                         the venv's mlx_lm
#                                                         resolves to this
#                                                         path (used by
#                                                         workstations
#                                                         running the open
#                                                         PR #1277 patch)
#   HF_HOME               (default $HOME/.cache/huggingface) — HF cache
#   PI_EXTRA_CONF         (default <repo>/server/extra-models/config.conf) —
#                         path to the extra-models config file; override
#                         to keep per-workstation choices out of the
#                         pi-tools tree (e.g. an operator wrapper points
#                         this at a checkout-local file with rows
#                         uncommented for the models that workstation has).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="${PI_VENV:-$HOME/.pi/agent/venv}"
VENV_PY="$VENV/bin/python"
MLX_SERVER_BIN="$VENV/bin/mlx_lm.server"
PI_MULTI="$SCRIPT_DIR/mlx-lm-multi"
LAUNCH="$PI_MULTI/launch.sh"
STOP="$PI_MULTI/stop.sh"
BASE_LOG="$PI_MULTI/logs/base.log"
PROXY_URL="http://localhost:18080"
EXPECTED_MLX_PATH="${PI_EXPECTED_MLX_PATH:-}"
HF_HUB_CACHE="${HF_HOME:-$HOME/.cache/huggingface}/hub"

EXTRA_DIR="$SCRIPT_DIR/extra-models"
EXTRA_CONF="${PI_EXTRA_CONF:-$EXTRA_DIR/config.conf}"
EXTRA_LOG_DIR="$EXTRA_DIR/logs"
EXTRA_PID_DIR="$EXTRA_DIR/pids"

BOLD=$'\033[1m'; YEL=$'\033[33m'; RED=$'\033[31m'; GRN=$'\033[32m'; RST=$'\033[0m'

die() { echo "${RED}error:${RST} $*" >&2; exit 1; }
warn() { echo "${YEL}warn:${RST} $*" >&2; }
info() { echo "$*"; }

# --- extra-models config loading --------------------------------------------

# Parallel arrays (bash 3.2 compatible — no associative arrays).
EXTRA_NAMES=()
EXTRA_PORTS=()
EXTRA_REPOS=()

load_extra_config() {
  [[ -f "$EXTRA_CONF" ]] || return 0
  local line cols
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"
    line="$(echo "$line" | xargs || true)"
    [[ -z "$line" ]] && continue
    # shellcheck disable=SC2206
    cols=( $line )
    if [[ ${#cols[@]} -ne 3 ]]; then
      warn "malformed row in $EXTRA_CONF: $line"
      continue
    fi
    EXTRA_NAMES+=("${cols[0]}")
    EXTRA_PORTS+=("${cols[1]}")
    EXTRA_REPOS+=("${cols[2]}")
  done < "$EXTRA_CONF"
}

extra_idx() {
  # Echo the index of name $1 in EXTRA_NAMES; return non-zero if absent.
  local target="$1" i
  for i in "${!EXTRA_NAMES[@]}"; do
    [[ "${EXTRA_NAMES[$i]}" == "$target" ]] && { echo "$i"; return 0; }
  done
  return 1
}

resolve_hf_snapshot() {
  # Given an HF repo id like mlx-community/Foo-4bit, echo the first
  # snapshot directory under $HF_HUB_CACHE. Return non-zero if missing.
  local repo="$1"
  local dir_name="models--${repo//\//--}"
  local snaps_dir="$HF_HUB_CACHE/$dir_name/snapshots"
  [[ -d "$snaps_dir" ]] || return 1
  local first
  first=$(ls -1 "$snaps_dir" 2>/dev/null | head -1)
  [[ -n "$first" ]] || return 1
  echo "$snaps_dir/$first"
}

extra_log() { echo "$EXTRA_LOG_DIR/$1.log"; }
extra_pid() { echo "$EXTRA_PID_DIR/$1.pid"; }
extra_url() { local idx; idx=$(extra_idx "$1") || return 1; echo "http://localhost:${EXTRA_PORTS[$idx]}"; }

extra_pid_alive() {
  local pidfile; pidfile=$(extra_pid "$1")
  [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null
}

# --- preconditions ----------------------------------------------------------

require_paths() {
  [[ -d "$VENV" ]]    || die "venv missing: $VENV (run server/bootstrap-mac.sh first)"
  [[ -x "$VENV_PY" ]] || die "venv python missing: $VENV_PY"
  [[ -x "$LAUNCH" ]]  || die "launch.sh missing: $LAUNCH"
  [[ -x "$STOP" ]]    || die "stop.sh missing: $STOP"
}

require_mlx_server_bin() {
  [[ -x "$MLX_SERVER_BIN" ]] || die "mlx_lm.server missing: $MLX_SERVER_BIN"
}

check_patched_build() {
  # Returns 0 if patched, 1 if stock, 2 if mlx_lm not importable.
  local resolved
  if ! resolved=$("$VENV_PY" -c 'import mlx_lm; print(mlx_lm.__file__)' 2>/dev/null); then
    return 2
  fi
  [[ "$resolved" == "$EXPECTED_MLX_PATH" ]]
}

warn_if_not_patched() {
  [[ -n "$EXPECTED_MLX_PATH" ]] || return 0
  local rc
  check_patched_build && rc=0 || rc=$?
  case "$rc" in
    0) info "${GRN}venv mlx-lm:${RST} patched ($EXPECTED_MLX_PATH)" ;;
    1) warn "venv mlx-lm is the ${BOLD}stock${RST} build, not the expected patched one at:"
       warn "  $EXPECTED_MLX_PATH"
       warn "To restore: uv pip install --python $VENV_PY -e <patched-checkout>" ;;
    2) die "mlx_lm not importable from the venv at all — venv is broken." ;;
  esac
}

# --- qwen track -------------------------------------------------------------

qwen_up() {
  info "${BOLD}>>> qwen track${RST}"
  "$LAUNCH"
}

qwen_down() {
  info "${BOLD}>>> qwen track${RST}"
  "$STOP"
}

# --- extra-models track (one per config row) -------------------------------

extra_up() {
  local name="$1"
  local idx
  if ! idx=$(extra_idx "$name"); then
    die "unknown extra-model: '$name' (configured: ${EXTRA_NAMES[*]:-(none)})"
  fi
  local port="${EXTRA_PORTS[$idx]}"
  local repo="${EXTRA_REPOS[$idx]}"

  require_mlx_server_bin

  local model_dir
  if ! model_dir=$(resolve_hf_snapshot "$repo"); then
    die "no HF cache snapshot for $repo; run \`hf download $repo\` first."
  fi

  info "${BOLD}>>> $name track${RST}"
  mkdir -p "$EXTRA_LOG_DIR" "$EXTRA_PID_DIR"

  if extra_pid_alive "$name"; then
    info "  already running (pid $(cat "$(extra_pid "$name")")); stopping first"
    extra_down_inner "$name"
  fi

  local logfile pidfile
  logfile=$(extra_log "$name")
  pidfile=$(extra_pid "$name")

  info "  port=$port  model=$model_dir"
  nohup "$MLX_SERVER_BIN" \
      --model "$model_dir" \
      --port "$port" \
      --host 127.0.0.1 \
      --prompt-cache-size 16 \
      --prompt-cache-bytes 2147483648 \
      >"$logfile" 2>&1 &
  echo $! > "$pidfile"
  sleep 1
  if extra_pid_alive "$name"; then
    info "  ${GRN}up${RST} (pid $(cat "$pidfile"))"
  else
    die "$name failed to start; tail $logfile"
  fi
}

extra_down_inner() {
  local name="$1"
  local pidfile; pidfile=$(extra_pid "$name")
  [[ -f "$pidfile" ]] || return 0
  local pid; pid="$(cat "$pidfile")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    local i
    for i in 1 2 3 4 5; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$pidfile"
}

extra_down() {
  local name="$1"
  if ! extra_idx "$name" >/dev/null; then
    die "unknown extra-model: '$name' (configured: ${EXTRA_NAMES[*]:-(none)})"
  fi
  info "${BOLD}>>> $name track${RST}"
  extra_down_inner "$name"
  info "  ${GRN}stopped${RST}"
}

extra_up_all() {
  if [[ ${#EXTRA_NAMES[@]} -eq 0 ]]; then
    info "  (no extra-models configured in $EXTRA_CONF)"
    return 0
  fi
  local name
  for name in "${EXTRA_NAMES[@]}"; do
    extra_up "$name"
  done
}

extra_down_all() {
  [[ ${#EXTRA_NAMES[@]} -eq 0 ]] && return 0
  local name
  for name in "${EXTRA_NAMES[@]}"; do
    extra_down "$name"
  done
}

# --- subcommands ------------------------------------------------------------

cmd_up() {
  require_paths
  warn_if_not_patched
  info ""
  local target="${1:-all}"
  case "$target" in
    all)
      qwen_up
      info ""
      extra_up_all
      ;;
    qwen)
      qwen_up
      ;;
    *)
      if extra_idx "$target" >/dev/null; then
        extra_up "$target"
      else
        die "unknown track: '$target' (use: all|qwen|${EXTRA_NAMES[*]:-})"
      fi
      ;;
  esac
  info ""
  info "tail logs:    $0 logs [base|<name>]"
  info "check health: $0 status"
}

cmd_down() {
  require_paths
  local target="${1:-all}"
  case "$target" in
    all)
      qwen_down
      extra_down_all
      ;;
    qwen)
      qwen_down
      ;;
    *)
      if extra_idx "$target" >/dev/null; then
        extra_down "$target"
      else
        die "unknown track: '$target' (use: all|qwen|${EXTRA_NAMES[*]:-})"
      fi
      ;;
  esac
  info "${GRN}stopped${RST}"
}

cmd_status() {
  require_paths
  warn_if_not_patched
  info ""
  info "${BOLD}listeners:${RST}"
  local ports=( 18080 18090 )
  local p
  if [[ ${#EXTRA_PORTS[@]} -gt 0 ]]; then
    for p in "${EXTRA_PORTS[@]}"; do ports+=( "$p" ); done
  fi
  local lsof_args=()
  for p in "${ports[@]}"; do lsof_args+=( -iTCP:"$p" ); done
  if ! lsof -nP "${lsof_args[@]}" -sTCP:LISTEN 2>/dev/null; then
    warn "  no listeners on any tracked port (${ports[*]})"
  fi
  info ""
  info "${BOLD}qwen proxy health:${RST}"
  if curl -sS -m 3 "$PROXY_URL/healthz" 2>/dev/null | jq -C . 2>/dev/null; then
    :
  else
    warn "  proxy at $PROXY_URL not responding"
  fi
  local i name url
  for i in "${!EXTRA_NAMES[@]}"; do
    name="${EXTRA_NAMES[$i]}"
    url="http://localhost:${EXTRA_PORTS[$i]}"
    info ""
    info "${BOLD}$name health:${RST}"
    if extra_pid_alive "$name"; then
      info "  pid $(cat "$(extra_pid "$name")") alive"
    else
      warn "  no $name pid"
    fi
    if curl -sS -m 3 "$url/v1/models" 2>/dev/null | jq -C '.data[0].id' 2>/dev/null; then
      :
    else
      warn "  $url/v1/models not responding"
    fi
  done
}

cmd_logs() {
  local which="${1:-base}"
  local logfile
  case "$which" in
    base|qwen) logfile="$BASE_LOG" ;;
    *)
      if extra_idx "$which" >/dev/null; then
        logfile=$(extra_log "$which")
      else
        die "unknown log: '$which' (use: base|qwen|${EXTRA_NAMES[*]:-})"
      fi
      ;;
  esac
  [[ -f "$logfile" ]] || die "no log yet: $logfile"
  info "tailing $logfile (Ctrl-C to exit)"
  exec tail -f "$logfile"
}

cmd_list() {
  info "${BOLD}qwen track:${RST}"
  info "  port=18080 (proxy) → 18090 (base) + any adapters in mlx-lm-multi/adapters.conf"
  info ""
  info "${BOLD}extra-models (from $EXTRA_CONF):${RST}"
  if [[ ${#EXTRA_NAMES[@]} -eq 0 ]]; then
    info "  (none configured)"
    return 0
  fi
  local i
  for i in "${!EXTRA_NAMES[@]}"; do
    info "  ${EXTRA_NAMES[$i]}  port=${EXTRA_PORTS[$i]}  ${EXTRA_REPOS[$i]}"
  done
}

cmd_help() {
  sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

load_extra_config

case "${1:-help}" in
  up|start)        shift || true; cmd_up "$@" ;;
  down|stop)       shift || true; cmd_down "$@" ;;
  status|health)   cmd_status ;;
  logs|log|tail)   shift || true; cmd_logs "$@" ;;
  list|ls)         cmd_list ;;
  help|-h|--help)  cmd_help ;;
  *) die "unknown subcommand: $1 (try '$0 help')" ;;
esac
