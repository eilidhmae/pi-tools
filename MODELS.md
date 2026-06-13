# MODELS.md

How to find and run pi with the Qwen3-Coder LoRA adapters.

> **Note — this is the opt-in `sft`/adapter track, not the default.** The
> deployed default is the **thinking-adversary** track (single Qwen3.5-27B
> `mlx_lm.server`, no adapters) — see
> [`docs/ONBOARDING-APPLE-SILICON.md`](docs/ONBOARDING-APPLE-SILICON.md). This
> document covers the Qwen3-Coder + LoRA adapter workflow, enabled with
> `server/bootstrap-mac.sh --with-sft` and `server/mlx-server.sh up sft`.

This document is the entry point for any agent or operator using the
adapter-based pi workflow. The full design rationale is in
[`model-plan.md`](model-plan.md).

---

## TL;DR

Two model paths coexist under pi:

| Path                 | Provider id    | Use when                                                      |
| -------------------- | -------------- | ------------------------------------------------------------- |
| Existing             | `ollama`       | You have `qwen3-coder:30b` already and want today's behavior. |
| New (this work)      | `local-mlx`    | You want LoRA-specialized 7B agents on Apple Silicon.         |

Adapter-based model ids look like:

```
qwen3-coder-30b-a3b              # base, no adapter
qwen3-coder-30b-a3b+go           # + worker-go
qwen3-coder-30b-a3b+rust         # + worker-rust       (skeleton only in v1)
qwen3-coder-30b-a3b+python       # + worker-python     (skeleton only in v1)
qwen3-coder-30b-a3b+tf           # + worker-tf         (skeleton only in v1)
qwen3-coder-30b-a3b+adversary    # + adversary-general
```

The harness selects an adapter by passing `--model qwen3-coder-30b-a3b+<suffix>`.
The orchestrator never selects an adapter for itself; it dispatches
managers/workers with adapters chosen from the routing table in
`extensions/lib/adapter-route.ts`.

---

## Local model roles & memory tiers (RPI)

The deployed local stack splits roles across models. "RPI" =
**R**esearch → **P**lan → **I**mplement. Reasoning-heavy roles run on the
262k-context thinking model; the implement step runs on a dense coder.

| Role                                            | Model                              | Provider id                  | Port    | Context | Notes                         |
| ----------------------------------------------- | ---------------------------------- | ---------------------------- | ------- | ------- | ----------------------------- |
| Session (interactive) / Adversary / Researcher / Planner | Qwen3.5-27B-4bit          | `local-mlx`                  | `:18080`| 262k    | thinking; session default     |
| Code Worker / Implementor                       | Qwen2.5-Coder-32B-Instruct-8bit    | `local-mlx-qwen25coder32b`   | `:18111`| 32k     | dense coder                   |
| Heavy single-session alternate                  | Qwen3-Coder-Next-80B-A3B 8-bit     | `local-mlx-80b`              | `:18130`| —       | MANUAL; 128GB-class only      |

### Two certified memory tiers

Unified memory governs how many tracks co-reside, which decides the map.
`install.sh` detects unified RAM (`hw.memsize`, overridable with
`PI_FORCE_MEM_GB`) and provisions accordingly; the floor for the large
tier is **112 GB** (128GB Macs report 128; 112 sits safely below 128 and
above any 64/96 box).

- **128GB-class (large tier, certified).** The 27B reasoning track and
  the ~35 GB 32B Code Worker run **concurrently** — 27B for the
  reasoning roles, the 32B for the implement step. The 80B is a **manual
  single-session alternate**: it runs ONE heavy track at a time and
  spawns no parallel agents. `install.sh` provisions the
  `local-mlx-qwen25coder32b` provider on this tier.
- **32GB-class (small tier, certified).** **27B for all roles**
  (small-context). The 32B Code Worker is **not** provisioned — the
  ~35 GB worker can't co-reside with the resident 27B. `install.sh`
  adds nothing extra here (additive-only; it never removes a
  provider an operator added by hand).
- **64GB is explicitly UNCERTIFIED** (future-contributor territory) and
  falls into the conservative small-tier profile until someone certifies
  it.

The session default stays the 27B (`local-mlx`); the tiering only governs
which *worker* providers are added.

### How roles reach their model

Role+model-pinned agents are exposed to the session as **pi-extension
worker tools** (the `research-worker` shape): the session calls a tool,
the tool dispatches a worker pinned to the right model. The model pin
lives in the `*-jailed.sh` scripts the worker tool invokes — not in
`models.json`. The Code Worker additionally depends on the
`qwen25coder-toolcall` extension, which repairs the dense coder's leaked
tool calls so they actually dispatch (it's a strict no-op for every other
model). Note: only the **research-worker** and **adversary** worker
extensions exist today; the dedicated **Planner** and **Coder** worker
extensions are a follow-on.

---

## Where the artifacts live

### Base model

`mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit` on Hugging Face. Downloaded
to `~/models/Qwen3-Coder-30B-A3B-Instruct-4bit/` by
`server/bootstrap-mac.sh --with-sft` (the sft base is opt-in; the default
install downloads only the Qwen3.5-27B thinking model).

### Adapters (one GitHub repo per adapter, all MIT, all public)

| Adapter             | Repo                                                              | v1 status  |
| ------------------- | ----------------------------------------------------------------- | ---------- |
| `worker-go`         | `github.com/eilidhmae/pi-adapter-worker-go`                       | Full       |
| `adversary-general` | `github.com/eilidhmae/pi-adapter-adversary-general`               | Full       |
| `worker-rust`       | `github.com/eilidhmae/pi-adapter-worker-rust`                     | Skeleton   |
| `worker-python`     | `github.com/eilidhmae/pi-adapter-worker-python`                   | Skeleton   |
| `worker-tf`         | `github.com/eilidhmae/pi-adapter-worker-tf`                       | Skeleton   |
| (template)          | `github.com/eilidhmae/pi-adapter-template`                        | Reference  |

Each release ships **five artifacts** so the adapter is portable across
Apple, CUDA/CPU, and Ollama/llama.cpp consumers:

| Asset                          | Consumer                                |
| ------------------------------ | --------------------------------------- |
| `adapter-mlx.safetensors`      | Apple Silicon via `mlx_lm`              |
| `adapter-peft.safetensors`     | HF Transformers + PEFT (CUDA, CPU, ROCm)|
| `adapter_config.json`          | PEFT loader sidecar                     |
| `merged-q4_k_m.gguf`           | Ollama / llama.cpp                      |
| `merged-q5_k_m.gguf`           | Ollama / llama.cpp (higher quality)     |
| `SHA256SUMS`                   | Verification                            |

Released under tags like `worker-go-v1`, `worker-go-v2`, …

### Variants and anti-patterns

- **Q8 base as opt-in for capacity, not quality.** An operator wanting
  more headroom can override `BASE_MODEL_REPO` in
  [`server/bootstrap-mac.sh`](server/bootstrap-mac.sh) to an 8-bit Qwen3-Coder-30B-A3B
  variant (verify the variant exists on Hugging Face before relying on it).
  This is *not* a recommended quality upgrade for coding tasks — there is no
  published benchmark showing a meaningful win over the 4-bit base for
  Qwen3-Coder-30B-A3B.
- **Do not fuse adapters into the base before serving.** The generic MLX
  guidance to "fuse adapters into the model for faster inference" assumes a
  single-model deployment. It actively hurts here: our routing layer expects
  `base + --adapter-path` per process, and a pre-fused checkpoint produces N
  redundant 5 GB merged weight sets with zero inference benefit.

---

## Running pi with an adapter (M5 Max)

### One-time setup

```bash
git clone https://github.com/eilidhmae/pi-tools ~/src/pi-tools
cd ~/src/pi-tools
./server/bootstrap-mac.sh         # installs MLX, downloads base, builds llama.cpp
bash install.sh                   # installs pi config to ~/.pi/agent/
```

### Pull a released adapter (dogfood — never use raw training output)

```bash
mkdir -p ~/models/adapters/worker-go
gh release download worker-go-v1 \
    -R eilidhmae/pi-adapter-worker-go \
    -p 'adapter-mlx.safetensors' -p 'adapter_config.json' \
    -D ~/models/adapters/worker-go/
```

### Start the inference server (default track)

```bash
cd ~/src/pi-tools/server
./mlx-lm-multi/launch.sh worker-go            # one mlx_lm.server + proxy on :18080
./mlx-lm-multi/healthcheck.sh                 # confirms /v1/models lists the id
```

### Use it from pi

```bash
pi --provider local-mlx --model qwen3-coder-30b-a3b+go \
    "write a table-driven test for ParseConfig in pkg/config/parse.go"
```

The orchestrator/manager skills document how to dispatch with the right
adapter when configured to do so — see "Adapter selection" in
[`skills/orchestrator/SKILL.md`](skills/orchestrator/SKILL.md). Adversary
adapter use is operator-opt-in (`--adapter` to `adversary-pass.sh`,
`--adversary-adapter` to `gen-review-revise.sh`); the harness does not
auto-detect or auto-switch.

### Switch to MOLA (opt-in track)

```bash
./mlx-lm-multi/stop.sh
./mola/launch.sh                              # one base + N adapters resident
./mola/healthcheck.sh
```

Same `:18080`, same model ids, same pi behavior. See
[`server/HEALTH.md`](server/HEALTH.md) for switch criteria.

---

## Running pi with an adapter (non-Apple consumer)

The GGUF release artifacts work anywhere Ollama or llama.cpp does.

```bash
gh release download worker-go-v1 \
    -R eilidhmae/pi-adapter-worker-go \
    -p 'merged-q4_k_m.gguf' -D /tmp/

cat > /tmp/Modelfile <<'EOF'
FROM /tmp/merged-q4_k_m.gguf
PARAMETER num_ctx 32768
EOF

ollama create qwen3-coder-30b-a3b-go -f /tmp/Modelfile
ollama run qwen3-coder-30b-a3b-go "write a table-driven test for ParseConfig"
```

Then point pi at Ollama:

```bash
pi --provider ollama --model qwen3-coder-30b-a3b-go "..."
```

---

## Training a new adapter

See [`model-plan.md`](model-plan.md) §"Training pipeline" and the
per-adapter `training/scripts/` directory in any
`pi-adapter-*` repo. Recipe is identical across adapters; only the
dataset and prompt template differ.

For the `adversary-general` adapter, training data accumulates
**automatically** while you use pi normally — see "Adversary capture
pipeline" in `model-plan.md` and
[`extensions/lib/adversary-capture.ts`](extensions/lib/adversary-capture.ts).

---

## Coexistence with the existing Ollama setup

Nothing in this work breaks the existing `qwen3-coder:30b` flow. The
`ollama` provider in `models.json` stays as-is. The new `local-mlx`
provider is additive. Operators choose at `--provider` time. Today's
sessions run unchanged.
