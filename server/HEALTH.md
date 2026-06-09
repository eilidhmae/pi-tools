# Inference Server Runbook

> **Scope:** the **default** deployment is the `thinking` track — a single
> `mlx_lm.server` (Qwen3.5-27B, no proxy, no adapters). For that track and
> fresh-machine setup, see
> [`../docs/ONBOARDING-APPLE-SILICON.md`](../docs/ONBOARDING-APPLE-SILICON.md);
> for 32 GB capacity, see [`../M2-MAX-32GB-FINDINGS.md`](../M2-MAX-32GB-FINDINGS.md).
> **This runbook below covers the legacy `sft` track** (`mlx-lm-multi` / `mola`),
> which adds a routing proxy and LoRA adapters.

## Which track am I running?

```bash
curl -sS http://localhost:18080/v1/models | jq .        # works for any track
curl -sS http://localhost:18080/healthz   | jq .track   # sft proxy → "mlx-lm-multi"/"mola"
```

The sft tracks expose `/v1/chat/completions`, `/v1/models`, `/healthz`. The
thinking track has no proxy, so `/healthz` is mlx_lm.server's built-in and
carries no `.track` field.

## When to use which

**Within the sft track, default to `mlx-lm-multi`.** Pick `mola` only after you have validated
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
watch -n 5 'curl -sS http://localhost:18080/healthz | jq .'
```

Reasonable budgets on a 128 GB M5 Max with the default track:

- 4 hot adapters × ~5 GB = ~20 GB resident inference
- KV caches under load: ~10 GB
- macOS + your apps: ~25 GB
- Headroom: ~70+ GB. If you cross 60 GB resident in inference, reduce
  `adapters.conf`.
- The `session-80b` track is the one exception to these small budgets: the
  80B alone is ~50 GB resident, and ~65 GB with the 27B `thinking` track up
  too — leave the rest as headroom and run no other heavy track alongside.

## 80B session track (:18130)

The `session-80b` track is a separate, opt-in heavy server — the 80B
agentic coder (`local-mlx-80b`) for interactive sessions, on its own port
so it can coexist with the 27B `thinking` track. It is **not** part of the
sft proxy and is launched directly:

```bash
./session-80b/launch.sh                 # start (or: stop)
curl -sS http://localhost:18130/v1/models | jq .   # confirm it's up
```

**Memory rule — one heavy track at a time.** Only run the 80B on a
128 GB-class machine. It is ~50 GB resident in typical use (MLX mmaps the
weights; cold MoE experts stay on disk) and ≤83 GB worst case; KV is tiny
(~1 GB). The 27B `thinking` track (~15 GB) may stay up alongside it, but do
**not** also run `sft` (`mlx-lm-multi`) or `extra-models` while the 80B is
up. If you see macOS swapping or `[metal::malloc] Resource limit exceeded`,
stop one track. The 80B also needs the patched venv mlx-lm (it emits
Qwen3-Coder XML tool calls; an unpatched server silently drops them).

## Schema invariants the harness depends on

- `/v1/models` includes a model with `id == "qwen3-coder-30b-a3b"` and one
  per `qwen3-coder-30b-a3b+<suffix>` configured adapter.
- `/v1/chat/completions` accepts the `model` field in `+suffix` form
  and returns OpenAI-compatible JSON. No `developer` role.
- `/healthz` returns `{"ok": true, "track": "...", "adapters": [...]}`.

If you change either track and break those invariants, the harness will
silently misroute or fall back to the base model.

## Verifying an adapter is actually applied (read this)

`mlx_lm.server --adapter-path` can **silently serve the base model**: the
adapter loads with no error, `/v1/models` and `/healthz` look correct, but
generations are byte-for-byte identical to the base. Endpoint health does
**not** catch this — only the *output* does.

**Root cause** (mlx-lm `server.py`, `ModelProvider.load`): the adapter is
resolved from `_adapter_map` *after* `model_path` has already been remapped from
the symbolic `"default_model"` key to the real filesystem path, so the lookup
misses and `adapter_path` falls back to `None`:

```python
model_path   = self._model_map.get(model_path, model_path)      # "default_model" -> /…/base
adapter_path  = self._adapter_map.get(model_path, adapter_path)  # get("/…/base") -> MISS -> None
```

This bites **mlx-lm-multi specifically**: `proxy.py` rewrites every request's
`model` field to `BASE_MODEL_DIR` before forwarding (so the `+suffix` is gone by
the time the backend sees it), and the backend's own boot-time `load_default()`
hits the same miss — so the per-adapter servers emit **base** output. The fix is
a one-line reorder (resolve adapter/draft by the original request key *before*
remapping `model_path`); patch the venv `mlx-lm` checkout until it lands
upstream (see "Known mlx-lm server limitations" below).

**Always A/B after any (re)launch — never trust `/healthz` alone:**

```bash
./mlx-lm-multi/verify-adapter.sh     # base vs each +suffix route; FAIL if identical
```

Identical base-vs-adapter output ⇒ the adapter is not applied. Skipping this
check once produced a full "adapter" evaluation that was silently scoring the
**base model** under each adapter's name — caught only by hashing the outputs.

## Known mlx-lm server limitations

These are upstream gaps as of `mlx-lm` v0.31.3 — flags that exist on
`mlx_lm.generate` but are **not** wired through `mlx_lm.server`. Worth
knowing so you don't burn time looking for a CLI knob that isn't there.

- **No KV-cache quantization.** `--kv-bits`, `--kv-group-size`,
  `--quantized-kv-start` are generate-only. For long-context (32k) workloads
  on multiple hot adapters, the lever is `adapters.conf` size + `vm_stat`,
  not server flags.
- **No `--max-kv-size`.** A single runaway long-context request can't be
  capped at the server CLI today.
- **`--adapter-path` silently no-ops** (see "Verifying an adapter is actually
  applied" above). `ModelProvider.load` looks up the adapter by the *resolved*
  model path instead of the request key, so it never matches. One-line fix:
  resolve `adapter_path`/`draft_model_path` from `_adapter_map`/`_draft_model_map`
  *before* the `model_path = self._model_map.get(...)` remap. **`server/bootstrap-mac.sh`
  applies this as PR #1249** in the patched venv build; `verify-adapter.sh` remains
  the output-level guard.
- Track upstream:
  <https://github.com/ml-explore/mlx-examples/tree/main/llms/mlx_lm>.
