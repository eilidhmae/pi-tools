# Plan: LoRA adapter pipeline for Qwen3-Coder under the pi harness

## Context

The pi harness (`github.com/eilidhmae/pi-tools`) today drives an
orchestrator → manager → worker → adversary loop against a single
`qwen3-coder:30b` model on Ollama. The shared design conversation
(M5 Max + MLX + Qwen3-Coder-7B + LoRA adapters + multi-adapter inference)
proposes a parallel track: a small base model with hot-swappable LoRA
adapters specialized per language/role, served locally, dispatched per
agent role.

This plan builds **everything that does not require Apple Silicon to
produce** — repo scaffolding, dataset construction, training configs,
harness extensions, inference launch scripts, distribution tooling,
docs — so that an M5 Max operator can `git clone`, run `bootstrap-mac.sh`,
and have a working end-to-end pipeline. Trained adapters are published as
**public, MIT-licensed** artifacts, portable across MLX (Apple), PEFT
(CUDA/CPU), and GGUF (llama.cpp/Ollama) so non-Apple consumers can use them.

**Dogfood rule**: the M5 Max consumes the *published GitHub Release
artifacts* for its own pi sessions — not in-tree training outputs. After
training and release, the operator points pi at the released MLX adapter
(downloaded back into `~/models/adapters/`) and at the released GGUF
(via Ollama on the Mac). This guarantees every release is validated end-
to-end on the trainer's own hardware before any external consumer touches
it. The "raw training output → use directly" shortcut is explicitly
disallowed.

The pi harness itself is left **adapter-agnostic by design**: model
selection flows through `--model` and `models.json` exactly as today,
so today's Ollama users are unaffected.

---

## Where work runs

| Runs here (Linux / WSL2)                                      | Runs on M5 Max (target)                             |
| ------------------------------------------------------------- | --------------------------------------------------- |
| Repo scaffolding, TS extensions, bash scripts                 | `mlx_lm.lora` training                              |
| Dataset construction (Python, language-agnostic)              | `mlx_lm.server` / MOLA inference                    |
| `models.json` templates, launch scripts, healthchecks         | Adapter merge + GGUF conversion for releases        |
| Capture pipeline for adversary consensus                      | Smoke-tests, latency/throughput benchmarks          |
| GitHub Actions: schema lint, JSONL/YAML validation            | Apple Neural Accelerator validation (Metal 4)       |
| All documentation                                             | The `pi` binary itself (already installed by user)  |

---

## Repository topology (all public, MIT, owner: eilidhmae)

### `pi-tools` (existing) — harness changes only

```
pi-tools/
├── AGENTS.md                            # +Adapter-Scoped Authority section
├── README.md                            # +adapter quick reference
├── MODELS.md                            # NEW: where models live, how to run with pi
├── install.sh                           # +models.json gets adapter-aware template
├── skills/
│   ├── orchestrator/SKILL.md            # +adapter selection table
│   ├── manager/SKILL.md                 # +pass adapter through to workers
│   ├── worker/SKILL.md                  # unchanged
│   └── adversary/SKILL.md               # +YAML output schema (see capture pipeline)
├── prompts/
│   └── adversary-review.md              # +structured-output instructions
├── extensions/
│   ├── adversary-hook.ts                # unchanged
│   ├── quorum.ts                        # +heterogeneous-model + temperature diversity
│   ├── adapter-route.ts                 # NEW: (role,domain) → model id
│   ├── adversary-parse.ts               # NEW: YAML fence parser w/ Zod schema
│   └── adversary-capture.ts             # NEW: emits training examples on consensus
├── tools/bash/
│   ├── adversary-check.sh               # unchanged
│   ├── adversary-pass.sh                # +--adapter / --domain flags
│   └── gen-review-revise.sh             # +adapter passthrough
└── server/                              # NEW: inference launch tooling
    ├── README.md                        # operator-facing
    ├── HEALTH.md                        # runbook (which track, when to fall back)
    ├── bootstrap-mac.sh                 # one-shot M5 Max setup
    ├── models.json.template             # MLX provider template
    ├── mlx-lm-multi/                    # default track
    │   ├── launch.sh                    # one mlx_lm.server per adapter
    │   ├── proxy.py                     # tiny FastAPI router (model+suffix → port)
    │   ├── proxy.service.plist          # launchd plist
    │   └── healthcheck.sh
    └── mola/                            # opt-in track
        ├── launch.sh
        ├── README.md                    # references the mlx-lm patch
        └── healthcheck.sh
```

### `pi-adapter-<name>` (new, one repo per adapter)

Per-adapter isolation = independent CI, independent release cadence, clean
provenance. Each repo follows the same template:

```
pi-adapter-worker-go/                    # template repo
├── LICENSE                              # MIT
├── README.md                            # what it is, how to install, eval results
├── DATASHEET.md                         # corpus, dates, hyperparams, eval, biases
├── adapter_config.json                  # PEFT-compatible config
├── training/
│   ├── config.yaml                      # mlx_lm.lora hyperparams + layer targets
│   ├── prompt-template.md               # system prompt the adapter expects
│   └── scripts/
│       ├── build-dataset.py             # corpus → train/valid/test JSONL
│       ├── train.sh                     # wraps mlx_lm.lora (runs on M5 Max)
│       ├── merge.sh                     # adapter + base → merged safetensors
│       ├── convert-gguf.sh              # merged → GGUF Q4_K_M / Q5_K_M
│       └── eval.py                      # held-out eval + format compliance
├── datasets/
│   ├── README.md                        # provenance, license of source corpora
│   ├── train.jsonl                      # if small/derivable; otherwise build script only
│   ├── valid.jsonl
│   └── test.jsonl
├── eval/
│   ├── golden/                          # held-out prompts + expected behavior
│   └── results/                         # per-release eval outputs
├── .github/
│   └── workflows/
│       ├── lint.yml                     # JSONL schema, YAML lint, dataset stats
│       └── release.yml                  # tag → expect 5 release assets uploaded by Mac
└── releases/                            # populated by GitHub Releases, not committed
    # adapter-mlx.safetensors            (Apple Silicon, native)
    # adapter-peft.safetensors           (HF/PEFT — CUDA, CPU, etc.)
    # adapter_config.json                (PEFT loader)
    # merged-q4_k_m.gguf                 (Ollama, llama.cpp)
    # merged-q5_k_m.gguf                 (Ollama, llama.cpp — higher quality)
    # SHA256SUMS
```

Initial repos created (empty/templated) here:
- `pi-adapter-worker-go`         (v1)
- `pi-adapter-adversary-general` (v1, capture-driven)
- `pi-adapter-template`          (the canonical template; new adapters fork from this)

`pi-adapter-worker-{rust,python,tf}` get repo skeletons but no datasets/
training in v1.

---

## Adapter distribution (portability)

Each adapter release ships **three formats**, all built on M5 Max via
`scripts/merge.sh && scripts/convert-gguf.sh`, uploaded as GitHub Release
assets:

| Format                                | Consumer                       | Size      |
| ------------------------------------- | ------------------------------ | --------- |
| `adapter-mlx.safetensors`             | Apple Silicon via mlx_lm      | ~50–500 MB |
| `adapter-peft.safetensors` + `adapter_config.json` | HF Transformers + PEFT (CUDA/CPU) | ~50–500 MB |
| `merged-q4_k_m.gguf`                  | Ollama / llama.cpp (any OS)    | ~4.5 GB   |
| `merged-q5_k_m.gguf`                  | Ollama / llama.cpp (higher Q)  | ~5.5 GB   |

The PEFT-compatible export is essentially the same safetensors with an
`adapter_config.json` PEFT recognizes — a one-step `mlx_lm`-side rename.
GGUF conversion uses `llama.cpp/convert_hf_to_gguf.py` against the merged
model. All three are deterministic from the same training run.

`SHA256SUMS` per release for verification.

---

## Inference (two-track)

Both tracks expose an OpenAI-compatible endpoint at `http://localhost:8080/v1`
and use the **same model-id naming convention** (`qwen3-coder-7b`,
`qwen3-coder-7b+go`, `qwen3-coder-7b+adversary`, …). The pi harness
cannot tell which track is running, and `models.json` is identical.

### Default track: `mlx-lm-multi` (one process per adapter, proxy-routed)

- `server/mlx-lm-multi/launch.sh` reads a config of `(adapter_name, port,
  adapter_path)` tuples and starts one `mlx_lm.server` per row, each loaded
  with one adapter against the same base.
- `proxy.py` (FastAPI, ~80 lines) accepts OpenAI requests on `:8080`,
  parses the `model` field's `+suffix`, and forwards to the right backend
  port. Falls back to base when no suffix.
- Memory: ~5 GB per process. Cap configured to 4 hot adapters (~20 GB)
  on a 128 GB box. Comfortable.
- `launchd` plist provided for autostart; `healthcheck.sh` for monitoring.
- **Why default**: rock-solid, no alpha dependencies, identical UX to MOLA
  from pi's perspective. You have a working pipeline on day one.

### Opt-in track: `mola` (one base, adapters routed per request)

- `server/mola/launch.sh` clones the MOLA repo, applies the documented
  `mlx-lm` patch, and launches the multi-LoRA server on `:8080` directly.
- ~5 GB memory total for base + N adapters resident.
- **Why opt-in**: alpha; needs the operator to validate stability on-Mac
  before relying on it. Switching is `make serve` → `make serve-mola`.

`server/HEALTH.md` documents the switch criteria and fallback procedure.

---

## Pi harness changes

### `extensions/adapter-route.ts` (new)

Maps `(role, domain) → model_id`. Adversary always gets the adversary
adapter regardless of language. Includes `inferDomain(signal)` — extension/
content heuristic. Used by `quorum.ts` and importable by other extensions.

### `extensions/adversary-parse.ts` (new)

Parses the adversary YAML fenced block (`adversary-review` fence label,
strict schema, controlled-vocabulary categories) using `yaml` + `zod`.
Tolerant normalizer for common drift (severity aliases, category aliases,
single-line `line` → `line_end`). Returns `{ok, review, errors, fatal}` so
the capture pipeline can distinguish "usable but warned" from "drop".

### `extensions/adversary-capture.ts` (new)

Hooks into quorum results. On ≥2-reviewer agreement, emits a
training-example record to `~/.pi/agent/training/adversary-captures/tier-{1,2,3}.jsonl`
with provenance (artifact path, git sha, model ids, temperatures, raw
reviews). Disagreements stashed separately. Tiered by (model heterogeneity
× finding-level agreement). See "Adversary capture pipeline" below.

### `extensions/quorum.ts` (modified)

- Read `PI_QUORUM_MODELS` (comma-separated) for **heterogeneous** quorum
  members; falls back to today's single `PI_QUORUM_MODEL` for
  back-compat.
- Vary temperature across peers (`0.2, 0.5, 0.7` defaults).
- After verdict aggregation, call `adversary-capture.ts`.

### `tools/bash/adversary-pass.sh`, `gen-review-revise.sh` (modified)

Add `--adapter` / `--domain` flags. Default behavior unchanged when not
passed. Forward to spawned `pi` via `--model qwen3-coder-7b+<suffix>`.

### `skills/orchestrator/SKILL.md`, `skills/manager/SKILL.md` (modified)

Add an **Adapter selection** section with the (role, domain) → model_id
table from `adapter-route.ts`. Orchestrator never selects an adapter
**for itself** (uses base) but chooses adapters for the managers/workers
it dispatches.

### `skills/adversary/SKILL.md`, `prompts/adversary-review.md` (modified)

Specify the YAML output schema, the eight-category controlled vocabulary,
and a worked example. This is the v1 schema; freeze for ≥6 months once
captures begin (changing the schema invalidates the dataset).

### `server/models.json.template`

New `local-mlx` provider pointing at `localhost:8080`. Lists
`qwen3-coder-7b` + the seven `+suffix` model ids. `compat.supportsDeveloperRole: false`.
Coexists with the existing `ollama` provider — operators choose at
`--provider` time.

---

## Adversary capture pipeline (drives the `adversary-general` dataset)

While the harness runs normally, every quorum review where ≥2 adversaries
agree produces a training-example record. Tiered:

| Tier | Condition                                                              | Use                       |
| ---- | ---------------------------------------------------------------------- | ------------------------- |
| 1    | ≥2 distinct base models agree on verdict **and** finding (file:line:cat) | Primary training signal   |
| 2    | Same model, temperature-diverse, agree on verdict **and** finding      | Augmentation, downweight  |
| 3    | Verdict-only agreement, same model                                     | Negative-example mining   |

Anchor examples from `adversary-check.sh` mechanical-tool failures
(staticcheck, go vet, etc.) are tagged as ground-truth and preserved
verbatim. Disagreements stashed separately for hand review (highest-information
training data).

`pi-adapter-adversary-general/training/scripts/build-dataset.py` (runs
anywhere) consumes the captures and emits the chat-format JSONL splits
ready for `mlx_lm.lora` on the M5 Max.

---

## Training pipeline (executes on M5 Max, scripts written here)

Per adapter, the recipe in `pi-adapter-<name>/training/scripts/`:

1. **`build-dataset.py`** — corpus → `train/valid/test.jsonl` chat format.
   Source-specific (e.g. for `worker-go`: walks Go repos, extracts
   function/test pairs, filters by length and license).
2. **`train.sh`** — `mlx_lm.lora` with `config.yaml` hyperparams.
   Reasonable defaults: 4-bit base (`mlx-community/Qwen3-Coder-7B-Instruct-4bit`),
   rank 16, alpha 32, learning rate 1e-5, batch size 4, ~1500 iters,
   gradient checkpointing on. Writes to `adapters/<name>/`.
3. **`eval.py`** — held-out eval + format-compliance check (does the
   adapter produce parseable output via `adversary-parse.ts` for adversary,
   syntactically valid Go for `worker-go`, etc.). Writes `eval/results/`.
4. **`merge.sh`** — fuses adapter into base → merged safetensors.
5. **`convert-gguf.sh`** — merged → Q4_K_M and Q5_K_M GGUF via llama.cpp.
6. **`release.sh`** — uploads the five artifacts + `SHA256SUMS` to a
   GitHub Release tagged `<name>-vN`.

Steps 4–6 are M5 Max only (need MLX + adequate disk; GGUF convert is
~30 min). Steps 1, 3 run anywhere.

`bootstrap-mac.sh` handles first-time setup: Homebrew deps, `uv`/Python,
`mlx-lm`, `huggingface_hub`, llama.cpp build for GGUF, base-model download
to `~/models/qwen3-coder-7b-4bit`, MLX 26.2+ check (Neural Accelerators).

---

## v1 adapter roster (recommended)

| Adapter             | Phase | Reason                                                                                                       |
| ------------------- | ----- | ------------------------------------------------------------------------------------------------------------ |
| `worker-go`         | v1    | Broadly useful audience, abundant public corpora (stdlib, popular OSS), tractable dataset construction.      |
| `adversary-general` | v1    | Dataset accumulates from normal harness use via the capture pipeline. Zero corpus prep cost.                 |
| `worker-rust`       | v2    | Same recipe as Go, lower-priority for v1.                                                                    |
| `worker-python`     | v2    | Same recipe.                                                                                                  |
| `worker-tf`         | v2    | Useful but corpus is more situational; left to operators with an in-house TF codebase.                       |

All five repos get scaffolded in v1 (template + DATASHEET stub + README).
Only `worker-go` and `adversary-general` get datasets/configs/training plumbing.

---

## Files to be created (here, this branch)

**In `pi-tools/`:**
- `MODELS.md` — operator entry point (where models live, how to run with pi, install/use)
- `model-plan.md` — mirror of this plan, in-repo for collaborators
- `extensions/adapter-route.ts`, `adversary-parse.ts`, `adversary-capture.ts`
- `extensions/quorum.ts` (modified)
- `tools/bash/adversary-pass.sh`, `gen-review-revise.sh` (modified)
- `skills/{orchestrator,manager,adversary}/SKILL.md` (modified)
- `prompts/adversary-review.md` (modified)
- `server/` (entire subtree above)
- `install.sh` (modified — adapter-aware models.json template)
- `AGENTS.md`, `README.md` (modified)

**New repos (created via `gh repo create`, public, MIT):**
- `pi-adapter-template`
- `pi-adapter-worker-go`
- `pi-adapter-adversary-general`
- `pi-adapter-worker-{rust,python,tf}` (skeleton only)

---

## Verification (end-to-end, on M5 Max)

1. `git clone pi-tools && cd pi-tools && ./server/bootstrap-mac.sh` →
   MLX installed, base model downloaded, llama.cpp built, `pi` confirmed.
2. `cd ~ && git clone pi-adapter-worker-go && cd pi-adapter-worker-go &&
   ./training/scripts/build-dataset.py && ./training/scripts/train.sh` →
   adapter weights in `adapters/worker-go/` (target: <90 min).
3. `./training/scripts/eval.py` → eval results, format compliance ≥ 95%.
4. `./training/scripts/merge.sh && ./training/scripts/convert-gguf.sh` →
   five release artifacts produced.
5. **Dogfood — fetch the released artifact back**:
   `gh release download worker-go-v1 -R eilidhmae/pi-adapter-worker-go
   -p 'adapter-mlx.safetensors' -D ~/models/adapters/worker-go/` →
   M5 Max now uses the *publicly released* adapter, not the in-tree
   training output.
6. `cd pi-tools/server && ./mlx-lm-multi/launch.sh worker-go` →
   `:8080` healthy, `curl /v1/models` lists `qwen3-coder-7b+go`.
7. From any project on the M5 Max: `pi --provider local-mlx --model
   qwen3-coder-7b+go "write a table-driven test for this function"`
   → response.
8. Run a real worker task through pi with the adapter; let the adversary
   quorum review it; confirm a tier-1 capture lands in
   `~/.pi/agent/training/adversary-captures/tier-1.jsonl`.
9. **Dogfood the GGUF path on the same Mac**:
   `gh release download worker-go-v1 -p 'merged-q4_k_m.gguf' &&
   ollama create qwen3-coder-7b-go -f Modelfile && ollama run …`
   → confirms the non-Apple distribution artifact also works on the
   trainer's machine before any external consumer sees it.
10. Switch MLX track to MOLA: `./server/mola/launch.sh` → same
    `curl /v1/models`, same pi behavior, adapter routing handled in-process.
11. **Portability spot-check** (separate non-Apple machine): `ollama pull`
    the GGUF release → `ollama run` → reasonable output. Confirms the
    cross-platform distribution path.

---

## Open items deferred (not in this plan)

- MOLA stability on M5 Max in 2026 (operator validates on-hardware).
- Concrete domain heuristic accuracy (the regex table in `inferDomain`
  is a starting point; refine after real usage).
- Quorum throughput under heterogeneous models (ollama + mlx_lm.server
  side-by-side for v1 quorum diversity; revisit if it becomes a bottleneck).
- Schema v2 (locked at v1 for ≥6 months once captures begin).
