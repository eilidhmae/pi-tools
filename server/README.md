# server/

Local inference launch tooling for the Qwen3-Coder + LoRA adapter setup,
plus side-by-side contrast models for heterogeneous-quorum review.
The two Qwen tracks expose the **same** OpenAI-compatible endpoint at
`http://localhost:18080/v1` and use the **same** model id naming
(`qwen3-coder-30b-a3b`, `qwen3-coder-30b-a3b+<adapter>`), so the pi harness and
`models.json` are identical between them. Contrast models run on
their own ports (`:18100+`) as sibling providers.

| Track          | When to use                                                | Memory   | Stability  |
| -------------- | ---------------------------------------------------------- | -------- | ---------- |
| `thinking`     | **Default.** Single `mlx_lm.server` serving Qwen3.5-27B (reasoning model), zero-shot, no adapters. | ~11–14 GB | Stable |
| `sft`          | **Legacy/opt-in.** Qwen3-Coder-30B-A3B base + per-adapter `mlx_lm.server` behind a proxy (the `mlx-lm-multi/` implementation). | ~11 GB ×N | Stable |
| `mola`         | Opt-in. One base + multiple adapters resident in one process. | ~11 GB | Alpha |
| `extra-models` | Side-by-side contrast servers for heterogeneous quorum. One process per config row. | ~11 GB ×N | Stable |
| `session-80b`  | **Opt-in, heavy.** 80B agentic coder (Qwen3-Coder-Next-80B-A3B, 8-bit) for interactive sessions — `local-mlx-80b` on `:18130`. Launched directly via `session-80b/launch.sh` (not through `mlx-server.sh`). Coexists with `thinking`; **mutually exclusive** with `sft`/`extra-models`. | ~50 GB (≤83 GB) | Beta |

> **Memory — read before starting `session-80b`.** Only run the 80B on a
> 128 GB-class Apple Silicon machine. It is ~50 GB resident in typical use
> (MLX mmaps the weights; cold MoE experts stay on disk) and up to ~83 GB
> worst case; its KV cache is tiny (~1 GB, `qwen3_next` hybrid linear
> attention). The 27B `thinking` track (~15 GB) can stay up alongside it,
> but **one heavy track at a time** — do not also run `sft`
> (`mlx-lm-multi`) or `extra-models` while the 80B is up, or you risk
> crossing the memory ceiling.

`thinking` and `sft` both bind :18080, so only one runs at a time.
`mlx-server.sh` is the operator entry point — it wraps the chosen track launcher
and additionally starts/stops/monitors each contrast server declared in
`extra-models/config.conf`:

```bash
bash mlx-server.sh up                  # thinking (default) + all uncommented extras
bash mlx-server.sh up thinking|sft     # one primary track
bash mlx-server.sh down [thinking|sft] # stop everything / one track
bash mlx-server.sh status              # listeners + /healthz + venv
bash mlx-server.sh list                # configured tracks
bash mlx-server.sh logs [thinking|sft|<name>]  # tail
```

The `session-80b` track is **not** wired into `mlx-server.sh` — it is a
standalone heavy track started directly: `./session-80b/launch.sh` (and
`./session-80b/launch.sh stop`).

See [`HEALTH.md`](HEALTH.md) for switching, fallback, and what to watch,
and [`extra-models/README.md`](extra-models/README.md) for adding a
contrast model.

## First-time setup (any Apple Silicon)

```bash
./bootstrap-mac.sh
```

Creates the venv, installs the **patched** mlx-lm (PR #1277/#1249), sets
`HF_HOME=~/models`, and downloads the Qwen3.5-27B thinking model flat into
`~/models`. Idempotent. On < 64 GB hosts it skips the llama.cpp build and the
launcher auto-tunes the server budget. Add `--with-sft` for the legacy
Qwen3-Coder adapter base. Full walkthrough:
[`../docs/ONBOARDING-APPLE-SILICON.md`](../docs/ONBOARDING-APPLE-SILICON.md).

### Autostart via launchd

The shipped `mlx-lm-multi/proxy.service.plist` contains a `_REPLACE_USER_`
placeholder for the operator's username. Render it and load it:

```bash
sed "s/_REPLACE_USER_/$USER/g" mlx-lm-multi/proxy.service.plist > \
    ~/Library/LaunchAgents/dev.eilidhmae.pi-mlx.plist
launchctl load ~/Library/LaunchAgents/dev.eilidhmae.pi-mlx.plist
```

## Files

```
server/
├── bootstrap-mac.sh           # one-shot Apple Silicon setup (venv, patched mlx-lm, model)
├── upgrade.sh                 # pull main + refresh stack + restart (merge-safe)
├── models.json.template       # copy into ~/.pi/agent/models.json
├── HEALTH.md                  # operator runbook
├── mlx-server.sh              # up/down/status/logs for all tracks
├── thinking-adversary/        # default track: single Qwen3.5-27B sidecar
│   └── launch.sh
├── session-80b/               # opt-in heavy track: 80B agentic session sidecar (:18130)
│   └── launch.sh
├── mlx-lm-multi/
│   ├── adapters.conf          # adapter_name port adapter_path  (one per line)
│   ├── launch.sh              # starts all configured backends + proxy
│   ├── stop.sh                # kills tracked PIDs
│   ├── proxy.py               # FastAPI router :18080 → backend ports
│   ├── proxy.service.plist    # launchd autostart for the proxy
│   └── healthcheck.sh
├── mola/
│   ├── launch.sh
│   ├── README.md              # links to the upstream MOLA repo + patch
│   └── healthcheck.sh
└── extra-models/
    ├── README.md              # adding a contrast model + models.json snippet
    ├── config.conf            # <short-name> <port> <hf-repo-id> rows
    ├── logs/                  # gitignored: <name>.log per row
    └── pids/                  # gitignored: <name>.pid per row
```
