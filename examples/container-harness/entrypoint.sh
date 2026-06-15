#!/usr/bin/env bash
# Container entrypoint for the pi-coding-agent sandbox.
#
# The Docker guest has its own network namespace, so the guest's 127.0.0.1 is
# NOT the host. On Docker the host is reachable at `host.docker.internal`
# (resolved natively on Docker Desktop; on Linux the launcher passes
# `--add-host=host.docker.internal:host-gateway` so it resolves there too). pi's
# config points the model endpoint at 127.0.0.1:18080 (correct on the host), so
# we forward the guest's 127.0.0.1:<port> to <gateway>:<port> — the same config
# works unchanged in both places.
#
# Do NOT use the resolv.conf nameserver as the gateway here: under Docker that is
# Docker's internal DNS (127.0.0.11), not the host.
#
# NOTE: this only succeeds if the HOST inference server listens on an interface
# the gateway reaches (bind it with HOST=0.0.0.0), NOT just 127.0.0.1.
#
# Tunables (env):
#   HOST_FORWARD_PORTS  space-separated ports to forward (default "18080")
#   HOST_GATEWAY        host address override (default host.docker.internal)
#   HOST_FORWARD        set to "0" to disable forwarding entirely
set -euo pipefail

if [ "${HOST_FORWARD:-1}" != "0" ] && command -v socat >/dev/null 2>&1; then
  gateway="${HOST_GATEWAY:-host.docker.internal}"
  for port in ${HOST_FORWARD_PORTS:-18080}; do
    if [ -n "$gateway" ]; then
      # guest 127.0.0.1:$port  ->  host $gateway:$port
      socat "TCP-LISTEN:${port},fork,reuseaddr,bind=127.0.0.1" "TCP:${gateway}:${port}" &
      echo "entrypoint: forwarding 127.0.0.1:${port} -> ${gateway}:${port}" >&2
    fi
  done
fi

exec "$@"
