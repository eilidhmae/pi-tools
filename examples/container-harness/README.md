# container-harness (Docker)

A Linux sandbox for running `pi-coding-agent` against the pi-tools MLX bank
running on your **Apple Silicon host**, using **Docker** (e.g. Docker Desktop).

Generation happens on the host (the `server/` track — no Metal in the guest);
this container is an isolated place for the agent to read and write a project
while reaching back to the host inference servers.

## What it does

- Runs a **Linux** guest with `pi-coding-agent` installed.
- **Bind-mounts your working directory** at `/opt/harness`.
- **Forwards the inference ports** (18080–18130) from the guest's `127.0.0.1` to
  the Docker host gateway via `socat`, so pi's `127.0.0.1`-pointed config reaches
  the host MLX servers unchanged.
- **Creates a guest user that matches you** — name, uid, and gid are detected at
  build time (`id -un` / `id -u` / `id -g`), so bind-mounted files keep correct
  ownership. Home is `/home/<you>`.
- Bakes the pi-tools agent (skills, extensions, RPI workers, scripts) and a
  provider map into the image.

## Prerequisites

- **Docker** (Docker Desktop on macOS, or Docker Engine on Linux).
- **`jq`** on the build host (the Makefile uses it to bake the provider map).
- **Host MLX servers** from this repo's `server/` track, **bound to `0.0.0.0`**
  so the gateway can reach them (not just `127.0.0.1`):

  ```bash
  HOST=0.0.0.0 bash server/mlx-server.sh up
  ```

  On a 32 GB host this serves the `qwen3-coder-30b-a3b` base on `:18080`
  (~11 GB resident) — see `M2-MAX-32GB-FINDINGS.md`. That is the default model
  this harness launches.

## Quick start

```bash
cd examples/container-harness
make build                 # build the image for YOUR user (one-time)

cd ~/src/some-project
/path/to/examples/container-harness/launch.sh        # drop into the RPI coordinator
/path/to/examples/container-harness/launch.sh bash   # get a shell instead
```

`make run` / `make shell` route through the same launcher but resolve the
project from the dir you run `make` in. For "from anywhere", call `launch.sh`
from your project dir (a thin shim on your `PATH` that `exec`s it is convenient).

## How the pieces fit

| File             | Role                                                            |
|------------------|-----------------------------------------------------------------|
| `Dockerfile`     | the image: node + socat + pi + the staged pi-tools agent; host-matched user |
| `entrypoint.sh`  | starts the `socat` host-port forwarder, then execs the command  |
| `launch.sh`      | `docker run` wrapper: bind-mounts, gateway, optional memory mount, default command |
| `Makefile`       | `build` (with user detection) / `run` / `shell` / `rebuild` / `clean` |
| `requirements.txt` | extra Python packages to bake in                              |

## Networking

The guest has its own network namespace, so its `127.0.0.1` is not the host. The
host is reached at **`host.docker.internal`**:

- **Docker Desktop** resolves it natively.
- **Docker Engine on Linux**: `launch.sh` passes
  `--add-host=host.docker.internal:host-gateway` so it resolves there too.

`entrypoint.sh` forwards each port in `HOST_FORWARD_PORTS` from the guest's
`127.0.0.1` to `host.docker.internal`. Bind the host servers with `HOST=0.0.0.0`
— a bind to `127.0.0.1` only is not reachable from the guest.

### Direct mode (skip socat)

```bash
./launch.sh --direct          # or: DIRECT=1 ./launch.sh
```

Sets `PI_LOCAL_HOST=host.docker.internal` (the `local-host-override` extension
repoints pi at the gateway) and `HOST_FORWARD=0` (entrypoint skips socat). One
fewer hop. Same image; the env selects it, no rebuild.

## Customization

- **Model / provider** — `PI_MODEL=... PI_PROVIDER=... ./launch.sh`. Default:
  `local-mlx` / `qwen3-coder-30b-a3b`.
- **Tools** — `PI_TOOLS="read,grep,..." ./launch.sh` overrides the coordinator
  tool surface.
- **Forwarded ports** — `HOST_FORWARD_PORTS="18080 18090" ./launch.sh`.
- **Python packages** — add to `requirements.txt`, `make build`.
- **A memory/identity store** — if you run a memory extension, point
  `PI_MEMORY_DIR` at its host store; it is mounted **read-only** under the guest
  home and the in-guest path is exported back as `PI_MEMORY_DIR`. Unset → skipped.

## Troubleshooting

- **Connection refused to the inference server** — the host server must listen
  on `0.0.0.0`, not just `127.0.0.1`. Re-launch it with `HOST=0.0.0.0`.
- **`host.docker.internal` not found (Linux)** — ensure you launch via
  `launch.sh` (it adds the `--add-host` mapping); a hand-rolled `docker run`
  needs it too.
- **Permission denied on bind-mounted files** — rebuild after changing your host
  uid/gid; the image is built for the user who ran `make build`.
