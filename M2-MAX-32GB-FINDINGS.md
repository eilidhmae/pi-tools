# M2 Max 32 GB — install + verification findings

Captured on branch `m2-max-32gb` against this host (Apple M2 Max, T6020, 12-core CPU,
30/38-core GPU, ~400 GB/s memory bandwidth, 32 GB unified memory, macOS 26.5).
The repo is currently tuned for Apple M5 Max / 128 GB. This document records what
the install does, what verification surfaced, and what an `m2-max-32gb` flavor
should change.

## What `bash install.sh --force` did

- Wrote AGENTS.md, skills, prompts, extensions, lib modules, tools to `~/.pi/agent/`.
- All installed bash scripts pass `bash -n`. All repo server scripts pass too.
- **Preserved** existing `~/.pi/agent/models.json` (ollama-only, model id `qwen3-coder`).
- **Preserved** existing `~/.pi/agent/settings.json` (`defaultProvider=ollama`,
  `defaultModel=qwen3-coder`).
- The Apple Silicon autodetect block (`install.sh:263-304`) **did not fire** because
  `:18080/v1/models` is not reachable yet (MLX server not running). Existing
  ollama-pointing settings remain in place — correct behavior.
- Printed the expected `NOTE: ... does not include the local-mlx provider`. That
  guidance is correct for an arm64 host that *will* run MLX, but on a fresh M2 box
  with no `~/.pi/agent/venv` and no `~/models/`, it's premature — the user can't
  use local-mlx until they run `server/bootstrap-mac.sh` first.

## Host state after install

| Component | Present? | Note |
|---|---|---|
| `pi` binary | yes | `/opt/homebrew/bin/pi` |
| `~/.pi/agent/` | yes | install populated it |
| `~/.pi/agent/venv` | **no** | `bootstrap-mac.sh` creates this, not `install.sh` |
| `~/models/Qwen3-Coder-30B-A3B-Instruct-4bit` | **no** | ~16 GB download, gated by `bootstrap-mac.sh` |
| `ollama` binary | yes | not running, no models pulled |
| `uv`, `gh`, `jq`, `brew` | yes | baseline OK |
| `cmake` | **no** | `bootstrap-mac.sh` installs it, only needed for llama.cpp GGUF conversion |
| macOS version | 26.5 | above the 26.2 floor in `bootstrap-mac.sh:78` |

## Issues found during verification

### 1. Misleading error in `server/mlx-server.sh:134`

```
error: venv missing: /Users/erobey/.pi/agent/venv (run pi-tools install.sh first)
```

I had already run `install.sh`. The venv is actually created by
`server/bootstrap-mac.sh:38-41`. The error should point at the bootstrap script,
not `install.sh`.

### 2. Stale private-repo paths in `tools/bash/adversary-pass.sh`

Lines 45 and 72 reference `~/src/my-macbook/...` (the pre-fork private repo).
These leak into the user's error stream on a fresh install:

```
ERROR: default backend http://localhost:18080 unreachable on
       Apple Silicon. Bring it up with:
         ~/src/my-macbook/mlx-server.sh up base
```

Should reference the pi-tools checkout path or be expressed as relative guidance.
DECISIONS.md is also referenced (line 64 of adversary-pass.sh) but doesn't exist
in pi-tools; it lives in the same private repo. The "corpus-contamination" rationale
should be summarized inline so non-author operators can read it.

### 3. Hard arm64 gate against ollama fallback (`adversary-pass.sh:66-78`)

Removed 2026-05-16. Reasonable for the author (avoids training-data contamination),
but on a fresh M2 Max where the operator just wants to *consume* pi-tools as a
harness (not train adapters), forcing the MLX stack to be up is a heavier
on-ramp than necessary. Worth an opt-in `--allow-ollama-fallback` or an
env-var escape hatch for non-training use.

### 4. `bootstrap-mac.sh` is labeled "M5 Max setup" but is generically arm64

Line 2 comment: `# bootstrap-mac.sh — one-shot M5 Max setup for the pi-tools adapter pipeline.`
The hardware guard is just `arm64` (line 11–14). Rename + reframe as generic
Apple Silicon, with an M2-Max-aware footnote.

### 5. `bootstrap-mac.sh` clones + builds llama.cpp unconditionally

Lines 100–113 clone llama.cpp and build it with Metal. That's only needed for
GGUF conversion, which adapter *consumers* never do. On a 32 GB box, the build
is several minutes of CPU. Make it opt-in (`--with-llama-cpp`), and skip
the `cmake` brew dep when it's not requested.

### 6. `install.sh` summary mentions `tools/bash/...` paths

The install.sh header (lines 26–30) advertises tools at `tools/bash/...`, but
the global install actually places them flat under `~/.pi/agent/tools/`
(install.sh:72 sets `TOOLS_DIR=${HOME}/.pi/agent/tools`). Documentation says
one thing, install does another. Confusing but not broken.

## Memory budget for M2 Max 32 GB

Confirmed by reading `server/mlx-lm-multi/launch.sh:49-55,85-91`:
each adapter row in `adapters.conf` spawns its **own full `mlx_lm.server`**
process with its own copy of the 4-bit base model (~16 GB resident). Adapters
do **not** share base weights across processes in the default `mlx-lm-multi`
track. `mola` does share, but is flagged alpha in `server/HEALTH.md:12-24`.

Realistic budget on M2 Max 32 GB:

| Configuration | Resident MLX | Headroom for OS+pi+browser+IDE | Verdict |
|---|---|---|---|
| Base only (`adapters.conf` empty) | ~16 GB | ~16 GB | comfortable |
| Base + 1 adapter | ~32 GB | ~0 GB | swap, decode collapse |
| Base + 2 adapters | ~48 GB | impossible | impossible |
| Any `extra-models` row | +~16 GB each | impossible alongside base | impossible |
| `mola` track (single process, multi-adapter) | ~16 GB | ~16 GB | feasible but alpha |

Practical M2 Max 32 GB envelope: **base-only**, no enabled adapter rows, no
contrast models. If a single adapter is essential, it must replace the base
mentally (you can't run both at once for long).

Bandwidth is **not** a bottleneck — M2 Max has the same memory bandwidth class
as M5 Max (~400 GB/s), so decode tok/s should be in the same ballpark as the
author's M5 Max numbers (≈70–96 tok/s for the 30B-A3B 4-bit model).
The 32 GB ceiling is the only meaningful constraint.

## Proposed `m2-max-32gb` flavor — change set

These changes target the `m2-max-32gb` branch and are intentionally minimal —
the install already ships M2-safe configs (everything commented out). Most of
the work is documentation, error-message cleanup, and a hardware-detection
nudge.

### Code/script changes

1. **`server/mlx-server.sh:134`** — replace the "run pi-tools install.sh first"
   error with a pointer to `server/bootstrap-mac.sh`.

2. **`tools/bash/adversary-pass.sh:45,72`** — replace `~/src/my-macbook/...`
   with the actual pi-tools server path, and inline a one-line summary of
   the 2026-05-16 ollama-fallback removal so operators don't need DECISIONS.md.

3. **`tools/bash/adversary-pass.sh:66-78`** — add an env-var escape hatch
   (`PI_TOOLS_ALLOW_OLLAMA_FALLBACK=1`) for arm64 consumers who aren't doing
   adapter training. Default off; document the contamination risk.

4. **`server/bootstrap-mac.sh`** —
   - Rename comment to "Apple Silicon setup."
   - Make llama.cpp clone+build opt-in (`--with-llama-cpp`).
   - Skip cmake install unless the flag is passed.
   - When `sysctl hw.memsize` < 64 GB, print an M2 advisory block:
     "Single-process ceiling: base model only. `adapters.conf` / `extra-models/`
     should stay empty. Expected decode ~70 tok/s on M2 Max."

5. **`install.sh`** — when arm64 *and* `hw.memsize` < 64 GB, surface the same
   M2 advisory at the end of the install summary.

### Documentation changes

6. **`README.md`** — add a hardware-target line under the title:
   "Built and primarily tested on Apple M5 Max / 128 GB. For 32 GB Apple Silicon
   hosts, see the `m2-max-32gb` branch."

7. **`server/HEALTH.md`** — add an M2-Max-32-GB capacity table next to the
   existing M5 Max one (mirror the layout at line 58–64).

8. **`MODELS.md`** — add a "32 GB profile" section: base-only operation,
   why mola is interesting on 32 GB once stable, when ollama fallback is
   acceptable.

9. **New: `M2-MAX-32GB.md`** at repo root — operator-facing one-pager
   summarizing the above (this file's content, trimmed and rewritten as
   user-facing prose rather than developer findings).

### Configurations to leave alone

- `server/mlx-lm-multi/adapters.conf` — already empty by default. No change.
- `server/extra-models/config.conf` — already empty by default. No change.
- `extensions/quorum.ts` — sequential, HTTP-only, negligible memory cost. No change.
- `install.sh`'s Apple-Silicon autodetect block — already idempotent and respects
  existing user settings; safe on M2 as-is.

## Verification not performed

I deliberately did **not** run `server/bootstrap-mac.sh` during this pass because
it would download ~16 GB of model weights and build llama.cpp from source.
Recommend the user run it (or a slimmer M2 version of it) themselves to validate
the full bring-up. End-to-end checks still pending:

- `bash server/bootstrap-mac.sh` completes on M2 Max 32 GB.
- `bash server/mlx-server.sh up` brings up the base process; resident memory ≈ 16 GB
  (confirm via Activity Monitor or `vm_stat`).
- `curl localhost:18080/v1/models` returns `qwen3-coder-30b-a3b`.
- `pi /adversary-review` against a small file produces a structured verdict.
- Quorum cycle (force a CONCERNS verdict) completes within ~4 min with no
  second `mlx_lm.server` process spawned.
- A single adapter row in `adapters.conf` brings resident memory to ~32 GB
  and confirms the predicted M2 ceiling.
