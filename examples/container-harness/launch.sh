#!/usr/bin/env bash
# Launch the pi sandbox from ANY directory. Bind-mounts the working dir at
# /opt/harness, forwards the host MLX ports via socat, and drops into the RPI
# coordinator (overridable). No environment variables to set by hand.
#
# `make run` / `make shell` route here. Override the image with
# `IMAGE=other-tag ./launch.sh`.
#
# Gateway / "direct" mode (opt-in):  ./launch.sh --direct [args]
#   Default: the guest reaches the host MLX bank via socat (guest 127.0.0.1 ->
#   host.docker.internal), matching the 127.0.0.1 pi config.
#   --direct: skip socat (HOST_FORWARD=0) and set PI_LOCAL_HOST so the
#   local-host-override extension repoints pi straight at the gateway. Requires
#   the host MLX servers bound to 0.0.0.0. Override the host with PI_LOCAL_HOST.
set -euo pipefail

IMAGE="${IMAGE:-pi-container-harness}"
# Guest home matches the host user the image was built for (same user runs this).
GUEST_HOME="/home/$(id -un)"

# Opt-in direct-to-gateway mode. Accept --direct ANYWHERE in the args (or
# DIRECT=1 in the environment) and consume it, so the remaining args still pass
# through to the image (pi, or `bash`, etc.).
DIRECT="${DIRECT:-0}"
_rest=()
for _a in "$@"; do
  if [ "$_a" = "--direct" ]; then DIRECT=1; else _rest+=("$_a"); fi
done
# bash 3.2 + set -u: guard the empty-array expansion.
set -- ${_rest[@]+"${_rest[@]}"}

PROJECT="$(pwd)"

# Build one argv array so it's never empty (macOS bash 3.2 errors on an empty
# "${arr[@]}" under set -u). --add-host makes host.docker.internal resolve on
# Linux; it is a harmless no-op on Docker Desktop where it already resolves.
args=( run --rm -it
  --add-host=host.docker.internal:host-gateway
  --volume "$PROJECT:/opt/harness" )

# Optional read-only memory/identity mount. Point PI_MEMORY_DIR at a host store
# to surface it to a memory extension inside the guest; it is mounted under the
# guest home (read-only — a sandbox reads identity, never writes it back) and the
# in-guest path is exported back as PI_MEMORY_DIR. No store / unset -> skipped.
if [ -n "${PI_MEMORY_DIR:-}" ] && [ -d "${PI_MEMORY_DIR}" ]; then
  target="${PI_MEMORY_TARGET:-$GUEST_HOME/.memory}"
  args+=( --mount "type=bind,source=${PI_MEMORY_DIR},target=${target},readonly" )
  args+=( --env "PI_MEMORY_DIR=${target}" )
  echo "launch: mounting memory store ${PI_MEMORY_DIR} -> ${target} (read-only)" >&2
fi

# Direct mode: repoint pi at the gateway and turn the socat forward off.
if [ "$DIRECT" = "1" ]; then
  args+=( --env "PI_LOCAL_HOST=${PI_LOCAL_HOST:-host.docker.internal}" --env "HOST_FORWARD=0" )
  echo "launch: --direct -> pi targets ${PI_LOCAL_HOST:-host.docker.internal}," \
       "socat off (host MLX servers must bind 0.0.0.0)" >&2
fi

# Default launch (no passthrough command) -> the RPI coordinator. The worker-
# dispatch tools are --tools-gated, so a bare `pi` could not drive the chain.
# This is a writable, NON-research session (the Coder writes the real tree) with
# the full coordinator surface + checksum. The jailed workers set their OWN
# restricted --tools and do not inherit this.
#
# Model: the 30B-A3B base the 32 GB host serves on :18080. Overrides:
#   - PI_PROVIDER / PI_MODEL, or pass your own command.
#   - PI_TOOLS for the tool set.
RPI_TOOLS="${PI_TOOLS:-read,grep,find,ls,bash,write,edit,research-worker,planner-worker,coder-worker,coder-review,adversary-review,checksum}"
if [ "$#" -eq 0 ]; then
  set -- pi \
    --provider "${PI_PROVIDER:-local-mlx}" \
    --model "${PI_MODEL:-qwen3-coder-30b-a3b}" \
    --tools "$RPI_TOOLS"
fi

# `./launch.sh bash` -> shell; any passthrough command overrides the default.
exec docker "${args[@]}" "$IMAGE" "$@"
