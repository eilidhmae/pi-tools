#!/usr/bin/env bash
# serverlib.sh — shared helpers for the MLX launchers in server/.
#
# Sourced (not executed) by the per-track launchers. Two helpers, both about
# failing loud and early instead of after an opaque mlx_lm.server traceback:
#
#   require_bindable_host HOST   pre-flight a non-wildcard bind address
#   wait_listening PORT PID LOG  confirm the server actually started listening
#
# bash 3.2 compatible (macOS system bash). No `set -e` here — callers own it.

# require_bindable_host HOST
#   Succeed if HOST is a wildcard (0.0.0.0 / :: / empty) or is currently
#   assigned to a local interface. Fail loud otherwise: binding an address that
#   no interface holds raises EADDRNOTAVAIL deep inside mlx_lm.server, but only
#   *after* it has begun loading the model — so the operator waits, then gets a
#   socketserver traceback instead of a one-line cause.
#
#   The specific trap on an Apple-Container host is HOST=192.168.64.1, the vmnet
#   NAT gateway: it is plumbed onto a host interface (bridge100) only while a
#   container instance is running on the 'default' network. With no container
#   up, the address does not exist and every bind to it fails. This check gates
#   on live `ifconfig` state, so it passes automatically the moment a container
#   brings the gateway up — it is not a hardcoded allowlist.
require_bindable_host() {
  local host="$1"
  case "$host" in
    0.0.0.0|::|"") return 0 ;;
  esac
  if ifconfig 2>/dev/null | grep -qw "inet $host"; then
    return 0
  fi
  echo "error: HOST=$host is not assigned to any local interface;" >&2
  echo "       the bind would fail with EADDRNOTAVAIL." >&2
  if [ "$host" = "192.168.64.1" ]; then
    echo "       192.168.64.1 is Apple container's vmnet NAT gateway. It is" >&2
    echo "       plumbed onto the host (bridge100) only while a container" >&2
    echo "       instance runs on the 'default' network — start a container" >&2
    echo "       first, or bind HOST=0.0.0.0." >&2
  else
    echo "       Bind HOST=0.0.0.0, or use an address shown by \`ifconfig\`." >&2
  fi
  return 1
}

# wait_listening PORT PID LOGFILE
#   Poll until PORT is actually LISTENING while process PID is still alive, then
#   return 0. Replaces the old `sleep 2; kill -0 "$pid"` liveness check, which
#   reported success on a *failed* bind: mlx_lm.server's model-load worker thread
#   keeps the process alive for several seconds after the main thread's bind()
#   has already raised, so `kill -0` alone passes while nothing is listening
#   (observed: launcher prints "up" yet `netstat`/`lsof` show no listener).
#
#   Two conditions, both required:
#     - PID is alive   — a failed bind dies within seconds; its death is the
#                        signal we return 1 on.
#     - PORT LISTENs   — the real "it's up" signal, host-agnostic so it works for
#                        any bind address.
#   The listener is matched by port alone (not -p PID) on purpose: the proxy
#   launchers run uvicorn with reload=True, where a *worker child* holds the
#   socket, not the supervisor PID we recorded — pinning -p PID there would time
#   out on a healthy server. A foreign listener masking a failure is a non-issue:
#   the launcher stop_existing's its own prior pid first, and a failed bind on an
#   occupied port (EADDRINUSE) kills PID, which the alive-check catches.
#
#   Returns 1 on early death or timeout (~15s; the bind precedes model load, so a
#   healthy server starts listening within ~1s).
wait_listening() {
  local port="$1" pid="$2" logfile="$3" i
  for i in $(seq 1 30); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "FAILED to start (process died); tail $logfile" >&2
      return 1
    fi
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  echo "FAILED to start (no listener on :$port after 15s); tail $logfile" >&2
  return 1
}
