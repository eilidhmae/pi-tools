#!/usr/bin/env bash
# llama-server.sh — sibling launcher for llama.cpp `llama-server` rows that
# serve a GGUF with an MTP (multi-token-prediction) speculative-decode draft.
#
# WHY a separate launcher (not a branch inside mlx-server.sh): the mlx launcher
# is tightly bound to `mlx_lm.server` — HF-repo→snapshot resolution feeding
# `--model`, mlx-only flag assembly, and an `is_mlx_server_pid` process gate.
# A llama-server row needs a different binary, GGUF *file* paths (main + draft),
# `--spec-type draft-mtp` flags, and a llama-aware pid gate. Bolting that onto
# the script that serves every mlx model is high blast-radius; a sibling that
# mirrors the up/down/status/logs interface and reuses the same lsof-reap /
# pidfile / logs patterns is additive and reversible (delete this file to undo).
#
# Established on this M5 Max by the 2026-06-25 definitive MTP matrix: drafting
# pays off via llama.cpp (Gemma-4 QAT 1.65–1.77×, no sliding-window cliff,
# loop-safe) but NOT via the mlx-lm spec-decode path on the served QAT model.
# `--reasoning off` is deliberate — it matches the non-thinking gemma4 contract
# and suppresses the `reasoning_content` field so pi's openai-completions
# provider gets plain content + native tool_calls (no shim). See my-macbook
# DECISIONS/CHANGELOG 2026-06-25 and tooling/speculative-decoding/.
#
# Rows live in extra-models/llama.conf. Usage:
#   llama-server.sh up   [name]   # start a row (default: all rows)
#   llama-server.sh down [name]   # stop a row (reaps by port, llama-gated)
#   llama-server.sh status        # health of every row
#   llama-server.sh logs [name]   # tail a row's log

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# llama-server binary: PATH first (Homebrew /opt/homebrew/bin), then the common
# brew location. Override with LLAMA_SERVER_BIN. Must be a build with
# `--spec-type draft-mtp` (llama.cpp ≥ 2026-06-07 / b≈9780).
LLAMA_SERVER_BIN="${LLAMA_SERVER_BIN:-$(command -v llama-server 2>/dev/null || echo /opt/homebrew/bin/llama-server)}"

# Same HOST contract as mlx-server.sh: 127.0.0.1 by default; HOST=0.0.0.0 to
# reach it from an Apple Container guest via the host bridge.
export HOST="${HOST:-127.0.0.1}"
# Health/status probes always target a loopback address, never the bind HOST:
# a wildcard bind (HOST=0.0.0.0, used so an Apple Container guest can reach the
# server via the host bridge) is not itself a connectable address on Linux, and
# curl to 0.0.0.0 is non-portable (it only happens to work on macOS). Mirrors
# mlx-server.sh, which probes localhost regardless of bind host.
case "$HOST" in
  0.0.0.0|::|"") CHECK_HOST=127.0.0.1 ;;
  *)             CHECK_HOST="$HOST" ;;
esac
HF_HUB_CACHE="${HF_HOME:-$HOME/.cache/huggingface}/hub"

EXTRA_DIR="$SCRIPT_DIR/extra-models"
LLAMA_CONF="${PI_LLAMA_CONF:-$EXTRA_DIR/llama.conf}"
LOG_DIR="$EXTRA_DIR/logs"
PID_DIR="$EXTRA_DIR/pids"
mkdir -p "$LOG_DIR" "$PID_DIR"

# Context window for the row when the config omits it. 8192 fits the
# coder/adversary workload; the matrix showed 256K loads at ~40 GB if needed.
LLAMA_CTX_DEFAULT="${LLAMA_CTX:-8192}"
# Draft tokens proposed per verify round. The matrix found K=2 the agentic
# sweet spot on QAT (K=3/4 add acceptance but lose throughput to verify cost).
LLAMA_N_DRAFT_DEFAULT="${LLAMA_SPEC_N_MAX:-2}"

BOLD=$'\033[1m'; YEL=$'\033[33m'; RED=$'\033[31m'; GRN=$'\033[32m'; RST=$'\033[0m'
die() { echo "${RED}error:${RST} $*" >&2; exit 1; }
warn() { echo "${YEL}warn:${RST} $*" >&2; }
info() { echo "$*"; }

# Parallel arrays (bash 3.2 compatible).
L_NAMES=(); L_PORTS=(); L_REPOS=(); L_MAIN=(); L_DRAFT=(); L_NDRAFT=(); L_CTX=()

load_conf() {
  [[ -f "$LLAMA_CONF" ]] || return 0
  local line cols
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"
    line="$(echo "$line" | xargs || true)"
    [[ -z "$line" ]] && continue
    # shellcheck disable=SC2206
    cols=( $line )
    # name port repo main-gguf draft-gguf [n-draft] [ctx]  (5–7 columns)
    if [[ ${#cols[@]} -lt 5 || ${#cols[@]} -gt 7 ]]; then
      warn "malformed row in $LLAMA_CONF (need 5–7 cols): $line"
      continue
    fi
    L_NAMES+=("${cols[0]}");  L_PORTS+=("${cols[1]}"); L_REPOS+=("${cols[2]}")
    L_MAIN+=("${cols[3]}");   L_DRAFT+=("${cols[4]}")
    L_NDRAFT+=("${cols[5]:-$LLAMA_N_DRAFT_DEFAULT}")
    L_CTX+=("${cols[6]:-$LLAMA_CTX_DEFAULT}")
  done < "$LLAMA_CONF"
}

idx_of() {
  local target="$1" i
  for i in "${!L_NAMES[@]}"; do
    [[ "${L_NAMES[$i]}" == "$target" ]] && { echo "$i"; return 0; }
  done
  return 1
}

resolve_hf_snapshot() {
  # HF repo id → first snapshot dir under the hub cache. Non-zero if missing.
  local repo="$1"
  local snaps_dir="$HF_HUB_CACHE/models--${repo//\//--}/snapshots"
  [[ -d "$snaps_dir" ]] || return 1
  local first; first=$(ls -1 "$snaps_dir" 2>/dev/null | head -1)
  [[ -n "$first" ]] || return 1
  echo "$snaps_dir/$first"
}

logfile() { echo "$LOG_DIR/$1.log"; }
pidfile() { echo "$PID_DIR/$1.pid"; }

pid_on_port() {
  # lsof exits non-zero when nothing is listening; with `set -o pipefail` that
  # would fail the `var="$(pid_on_port …)"` assignment under `set -e`. Swallow
  # it so an empty result is a clean "" rather than an aborted script.
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1 || true
}

is_llama_server_pid() {
  # True if PID $1 is a llama-server process — gates the port-fallback reap so
  # we never signal an unrelated program holding the port.
  local pid="$1" cmd
  cmd="$(ps -p "$pid" -o command= 2>/dev/null)" || return 1
  [[ "$cmd" == *llama-server* ]]
}

http_ok() { # url -> 0 if HTTP 200
  [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$1" 2>/dev/null)" == "200" ]]
}

row_up() {
  local name="$1" idx; idx=$(idx_of "$name") || die "no such row: $name"
  local port="${L_PORTS[$idx]}" repo="${L_REPOS[$idx]}"
  local mainrel="${L_MAIN[$idx]}" draftrel="${L_DRAFT[$idx]}"
  local ndraft="${L_NDRAFT[$idx]}" ctx="${L_CTX[$idx]}"
  local lf pf; lf="$(logfile "$name")"; pf="$(pidfile "$name")"

  [[ -x "$LLAMA_SERVER_BIN" ]] || die "llama-server not found ($LLAMA_SERVER_BIN); brew install llama.cpp"

  if http_ok "http://$CHECK_HOST:$port/health"; then
    info "${GRN}already up${RST}  $name  http://$HOST:$port"
    return 0
  fi
  local existing; existing="$(pid_on_port "$port")"
  if [[ -n "$existing" ]]; then die "port $port already held by pid $existing (not a healthy llama row)"; fi

  local snap; snap="$(resolve_hf_snapshot "$repo")" \
    || die "HF snapshot for $repo not in cache ($HF_HUB_CACHE); run: hf download $repo"
  local main="$snap/$mainrel" draft="$snap/$draftrel"
  [[ -f "$main"  ]] || die "main GGUF missing: $main"
  [[ -f "$draft" ]] || die "draft (MTP) GGUF missing: $draft"
  local alias="${repo##*/}"   # pi provider model id == this

  info "${BOLD}>>> $name (llama-server + MTP draft)${RST}"
  info "  port=$port  ctx=$ctx  n-draft=$ndraft  alias=$alias"
  info "  main=$mainrel  draft=$draftrel"

  # --reasoning off: suppress reasoning_content (matches non-thinking gemma4
  # contract; pi gets plain content + native tool_calls). -fa on: flash attn.
  # -ngl 999: full GPU offload (Metal). Re-tune -ngl/-c on non-M5 hosts.
  nohup "$LLAMA_SERVER_BIN" \
    -m "$main" \
    --spec-draft-model "$draft" \
    --spec-type draft-mtp \
    --spec-draft-n-max "$ndraft" \
    -ngl 999 -fa on --jinja --reasoning off \
    --alias "$alias" \
    --host "$HOST" --port "$port" -c "$ctx" \
    >>"$lf" 2>&1 &
  echo $! >"$pf"

  local i
  for i in $(seq 1 90); do
    if http_ok "http://$CHECK_HOST:$port/health"; then
      info "  ${GRN}up${RST} (pid $(cat "$pf"))  listening=$HOST:$port"; return 0
    fi
    if ! kill -0 "$(cat "$pf")" 2>/dev/null; then warn "process died during load — see $lf"; return 1; fi
    sleep 2
  done
  warn "did not become healthy within 180s — see $lf"; return 1
}

row_down() {
  local name="$1" idx; idx=$(idx_of "$name") || die "no such row: $name"
  local port="${L_PORTS[$idx]}" pf; pf="$(pidfile "$name")"
  # Kill list from pidfile + whatever llama-server LISTENs on the port (so a
  # hand-launched / crash-orphaned server is still reaped). Port fallback gated
  # on is_llama_server_pid so we never signal an unrelated process.
  # Both the pidfile PID and the port listener are gated on is_llama_server_pid
  # so a recycled/stale PID can never make us SIGTERM an unrelated process.
  local pids=() fpid lpid
  if [[ -f "$pf" ]]; then
    fpid="$(cat "$pf" 2>/dev/null || true)"
    if [[ -n "$fpid" ]] && is_llama_server_pid "$fpid"; then pids+=("$fpid"); fi
  fi
  lpid="$(pid_on_port "$port")"
  if [[ -n "$lpid" ]] && is_llama_server_pid "$lpid"; then pids+=("$lpid"); fi
  if [[ ${#pids[@]} -eq 0 ]]; then info "$name already down"; rm -f "$pf"; return 0; fi
  local p
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  for _ in $(seq 1 20); do
    lpid="$(pid_on_port "$port")"
    if [[ -z "$lpid" ]]; then break; fi
    sleep 0.5
  done
  lpid="$(pid_on_port "$port")"
  if [[ -n "$lpid" ]] && is_llama_server_pid "$lpid"; then
    kill -9 "$lpid" 2>/dev/null || true
  fi
  rm -f "$pf"
  info "${GRN}stopped${RST} $name"
}

row_status() {
  local name="$1" idx; idx=$(idx_of "$name") || return 1
  local port="${L_PORTS[$idx]}"
  if http_ok "http://$CHECK_HOST:$port/health"; then
    info "  ${GRN}up${RST}    $name  http://$HOST:$port"
  else
    local lpid; lpid="$(pid_on_port "$port")"
    if [[ -n "$lpid" ]]; then info "  ${YEL}busy${RST}  $name  pid $lpid on :$port (loading or unhealthy)"
    else info "  ${RED}down${RST}  $name  :$port"; fi
  fi
}

main() {
  load_conf
  [[ ${#L_NAMES[@]} -gt 0 ]] || die "no rows in $LLAMA_CONF"
  local cmd="${1:-status}"; shift || true
  case "$cmd" in
    up)
      if [[ $# -gt 0 ]]; then row_up "$1"; else for n in "${L_NAMES[@]}"; do row_up "$n"; done; fi ;;
    down)
      if [[ $# -gt 0 ]]; then row_down "$1"; else for n in "${L_NAMES[@]}"; do row_down "$n"; done; fi ;;
    status)
      info "${BOLD}llama-server rows${RST}"; for n in "${L_NAMES[@]}"; do row_status "$n"; done ;;
    logs)
      local n="${1:-${L_NAMES[0]}}"; exec tail -f "$(logfile "$n")" ;;
    *) die "usage: llama-server.sh {up|down|status|logs} [name]" ;;
  esac
}

main "$@"
