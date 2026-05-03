# server/

Local inference launch tooling for the Qwen3-Coder + LoRA adapter setup.
Two tracks expose the **same** OpenAI-compatible endpoint at
`http://localhost:8080/v1` and use the **same** model id naming
(`qwen3-coder-7b`, `qwen3-coder-7b+<adapter>`), so the pi harness and
`models.json` are identical between them.

| Track          | When to use                                                | Memory   | Stability  |
| -------------- | ---------------------------------------------------------- | -------- | ---------- |
| `mlx-lm-multi` | **Default**. Rock-solid. One `mlx_lm.server` per adapter.  | ~5 GB ×N | Stable     |
| `mola`         | **Opt-in**. One base + multiple adapters resident.         | ~5 GB    | Alpha      |

See [`HEALTH.md`](HEALTH.md) for switching, fallback, and what to watch.

## First-time setup (M5 Max only)

```bash
./bootstrap-mac.sh
```

Installs MLX 26.2+, downloads the base model, builds `llama.cpp` for
GGUF conversion, and confirms the Apple Neural Accelerators are visible.
Idempotent.

## Files

```
server/
├── bootstrap-mac.sh           # one-shot M5 Max setup
├── models.json.template       # copy into ~/.pi/agent/models.json
├── HEALTH.md                  # operator runbook
├── mlx-lm-multi/
│   ├── adapters.conf          # adapter_name port adapter_path  (one per line)
│   ├── launch.sh              # starts all configured backends + proxy
│   ├── stop.sh                # kills tracked PIDs
│   ├── proxy.py               # FastAPI router :8080 → backend ports
│   ├── proxy.service.plist    # launchd autostart for the proxy
│   └── healthcheck.sh
└── mola/
    ├── launch.sh
    ├── README.md              # links to the upstream MOLA repo + patch
    └── healthcheck.sh
```
