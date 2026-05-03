# Inference Server Runbook

## Which track am I running?

```bash
curl -sS http://localhost:8080/healthz | jq .track
# → "mlx-lm-multi"  or  "mola"
```

Both expose `/v1/chat/completions`, `/v1/models`, `/healthz`.

## When to use which

**Default to `mlx-lm-multi`.** Pick `mola` only after you have validated
it on this exact M5 Max for at least one full week of normal pi usage
without crashes or wedged adapters.

| Symptom                                               | Track     | Likely cause                                |
| ----------------------------------------------------- | --------- | ------------------------------------------- |
| Single adapter wedges; restart fixes; others fine     | mlx-multi | Process-local memory pressure, restart it   |
| All adapters slow at once                             | either    | Other apps eating bandwidth — close them    |
| Some adapter requests get other adapter's outputs     | mola      | Routing bug → fall back to mlx-lm-multi     |
| Hangs / OOM crashes / Metal errors                    | mola      | Alpha instability → fall back               |
| Excess RAM use; macOS swapping                        | mlx-multi | Too many hot adapters; reduce to 4 max      |

## Fallback procedure

```bash
# Stop current track
./mlx-lm-multi/stop.sh   2>/dev/null || true
./mola/stop.sh           2>/dev/null || true

# Start the other one
./mlx-lm-multi/launch.sh             # rock-solid default
# or
./mola/launch.sh                     # alpha
```

`models.json` does **not** change. The pi harness does not care which
track is up.

## What to watch (M5 Max)

```bash
# Memory pressure
vm_stat 5

# Process-level
ps -axo pid,rss,command | grep -E 'mlx_lm.server|mola' | sort -k2 -n

# GPU / Neural Accelerator activity
sudo powermetrics --samplers gpu_power -n 3 -i 1000

# Endpoint
watch -n 5 'curl -sS http://localhost:8080/healthz | jq .'
```

Reasonable budgets on a 128 GB M5 Max with the default track:

- 4 hot adapters × ~5 GB = ~20 GB resident inference
- KV caches under load: ~10 GB
- macOS + your apps: ~25 GB
- Headroom: ~70+ GB. If you cross 60 GB resident in inference, reduce
  `adapters.conf`.

## Schema invariants the harness depends on

- `/v1/models` includes a model with `id == "qwen3-coder-7b"` and one
  per `qwen3-coder-7b+<suffix>` configured adapter.
- `/v1/chat/completions` accepts the `model` field in `+suffix` form
  and returns OpenAI-compatible JSON. No `developer` role.
- `/healthz` returns `{"ok": true, "track": "...", "adapters": [...]}`.

If you change either track and break those invariants, the harness will
silently misroute or fall back to the base model.
