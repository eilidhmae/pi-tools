# mola/ — opt-in multi-LoRA inference track

[MOLA](https://github.com/Goekdeniz-Guelmez/mlx-lm-mola) (or the current
upstream multi-LoRA mlx fork; check the repo before launching) keeps one
base model resident in unified memory and routes per-request to one of N
LoRA adapters. On a 128 GB M5 Max with the 4-bit Qwen3-Coder-7B base, that
fits the base + 8+ adapters in well under 10 GB total — versus ~5 GB ×N
for the default `mlx-lm-multi` track.

**Status as of this repo's v1**: alpha, requires a documented `mlx-lm`
patch, may not survive sustained use. Treat as opt-in until you have
validated it for at least one full week of normal pi usage on this exact
M5 Max without crashes or wedged adapters.

Switching is symmetric — see [`../HEALTH.md`](../HEALTH.md) "Fallback
procedure". `models.json` does not change. Pi cannot tell which track is
running.

## Launch

```bash
./launch.sh
./healthcheck.sh
```

`launch.sh` clones MOLA into `~/src/mola/` if absent, applies the patch,
and starts the server bound to `:8080` with the same model id naming
(`qwen3-coder-7b+<suffix>`). Adapters listed in `../mlx-lm-multi/adapters.conf`
are reused — single source of truth for which adapters are hot.

## Stop

```bash
./stop.sh
```

## When to fall back

See [`../HEALTH.md`](../HEALTH.md). Typical signals: cross-adapter output
contamination, hangs, OOM/Metal errors, throughput collapse under
mixed-adapter concurrency.
