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
| `mlx-lm-multi` | **Default Qwen track**. Rock-solid. One `mlx_lm.server` per adapter. | ~5 GB ×N | Stable     |
| `mola`         | **Opt-in Qwen track**. One base + multiple adapters resident. | ~5 GB    | Alpha      |
| `extra-models` | **Side-by-side contrast servers** for heterogeneous quorum. One process per config row. | ~5 GB ×N | Stable     |

`mlx-server.sh` is the operator entry point — it wraps the Qwen-track
launcher and additionally starts/stops/monitors each contrast server
declared in `extra-models/config.conf`:

```bash
bash mlx-server.sh up                  # Qwen + all uncommented extras
bash mlx-server.sh up qwen|<name>      # one track
bash mlx-server.sh down                # stop everything
bash mlx-server.sh status              # listeners + /healthz + venv
bash mlx-server.sh list                # configured tracks
bash mlx-server.sh logs [base|<name>]  # tail
```

See [`HEALTH.md`](HEALTH.md) for switching, fallback, and what to watch,
and [`extra-models/README.md`](extra-models/README.md) for adding a
contrast model.

## First-time setup (M5 Max only)

```bash
./bootstrap-mac.sh
```

Installs MLX 26.2+, downloads the base model, builds `llama.cpp` for
GGUF conversion, and confirms the Apple Neural Accelerators are visible.
Idempotent.

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
├── bootstrap-mac.sh           # one-shot M5 Max setup
├── models.json.template       # copy into ~/.pi/agent/models.json
├── HEALTH.md                  # operator runbook
├── mlx-server.sh              # up/down/status/logs for all tracks
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
