# Onboarding: pi-tools on a fresh Apple Silicon machine

This is the canonical setup walkthrough for a **new** Apple Silicon dev box
(M2/M3/M4/M5, any RAM). It gets you a working local inference stack and the pi
harness, and explains the two things that surprise people: the **`~/models`**
layout and the **patched mlx-lm** server.

pi-tools was built on an M5 Max / 128 GB workstation. Everything here also works
on smaller boxes (e.g. M2 Max / 32 GB) — the install auto-tunes the server down
on hosts with < 64 GB.

---

## What you end up with

- A single `mlx_lm.server` — the **thinking-adversary** track — serving
  **Qwen3.5-27B-4bit** (a reasoning model) at `http://127.0.0.1:18080/v1`.
- A patched `mlx-lm` editable-installed into `~/.pi/agent/venv`.
- All models + HuggingFace cache under **`~/models`**.
- The pi harness (`~/.pi/agent/`) defaulting to the thinking model.

The legacy **sft track** (Qwen3-Coder-30B-A3B + LoRA adapters) is opt-in and not
needed for normal use — see the end of this doc.

---

## Model roles & memory tiers

`install.sh` detects unified memory and provisions local-model providers
for one of two certified tiers:

- **128GB-class (large tier).** The 27B reasoning model
  (`local-mlx`, `:18080`) serves the Session / Researcher / Planner roles, and
  **Gemma-4-31B-it** (`local-mlx-gemma431b`, `:18112`) is the **default Code
  Worker + Adversary** (thinking-off), running concurrently for the implement
  step and the gates. `install.sh` also provisions the **Qwen2.5-Coder-32B**
  (`local-mlx-coder32b`, `:18111`) as the `PI_CODER_TIER=large` alternative —
  also useful as the *heterogeneous* reviewer when the default coder+adversary
  (same gemma model) need an independent second model. (The 80B track is a
  separate manual single-session alternate — see the end of this doc.)
- **Smaller hosts (32GB-class).** The 27B serves **all** roles; the
  ~35 GB 32B Code Worker is **not** provisioned (it can't co-reside with
  the resident 27B), so `install.sh` adds nothing extra.
- **64 GB is uncertified** and uses the smaller-host profile for now.

See [`MODELS.md`](../MODELS.md) → "Local model roles & memory tiers (RPI)"
for the full role→model table and the worker-tool wiring.

---

## Prerequisites

- Apple Silicon Mac, macOS 26.2+ recommended.
- [Homebrew](https://brew.sh).
- The `pi` CLI (`pi-coding-agent`) on your `PATH`.
- ~20 GB free disk for the thinking model, plus headroom.

---

## First-time setup

```bash
# 1. Clone the tools and bootstrap the inference stack.
git clone git@github.com:eilidhmae/pi-tools.git ~/src/pi-tools
cd ~/src/pi-tools
bash server/bootstrap-mac.sh
```

`bootstrap-mac.sh` is idempotent and does:

1. Installs `uv`, `gh`, `jq` via Homebrew (skips llama.cpp build on < 64 GB).
2. Creates the venv at `~/.pi/agent/venv` (Python 3.12).
3. Clones `mlx-lm` to `~/src/mlx-lm`, merges the required PRs onto a
   `pi-tools-patched` branch, and editable-installs it into the venv
   (see **Patched mlx-lm** below).
4. Sets and persists **`HF_HOME=~/models`** (appends to your shell rc if absent).
5. Downloads the **thinking model** flat to `~/models/Qwen3.5-27B-4bit`.

```bash
# 2. Install the pi harness config (skills, extensions, AGENTS.md, models.json,
#    and the thinking-model default). Respects any existing ~/.pi settings.
bash install.sh

# 3. Pick up HF_HOME in your current shell (new shells get it automatically).
source ~/.zshrc        # or ~/.bashrc

# 4. Bring up the server (thinking-adversary track is the default).
bash server/mlx-server.sh up thinking

# 5. Verify.
curl -sS http://127.0.0.1:18080/v1/models | jq .
pi -p "Reply with exactly one word: ready"     # should print: ready
```

The first generation request loads the 27B model into memory (tens of seconds);
subsequent requests are fast.

---

## The `~/models` layout (and `HF_HOME`)

pi-tools keeps **all** HuggingFace models and cache under `~/models`:

```bash
export HF_HOME="$HOME/models"     # bootstrap persists this to your shell rc
```

Result:

- HF cache (repo-id downloads, snapshots): `~/models/hub/...`
- Flat model dirs used directly by the server: `~/models/Qwen3.5-27B-4bit/`,
  `~/models/Qwen3-Coder-30B-A3B-Instruct-4bit/` (sft, opt-in).

Override the root with `MODELS_DIR=/some/path bash server/bootstrap-mac.sh`.

> **Already have models in `~/.cache/huggingface`?** Move them once
> (same-volume `mv` is instant): `mv ~/.cache/huggingface/* ~/models/`.

### Flat dir vs HF cache tree — the #1 gotcha

`mlx_lm.server` is started with `--model <path>` and reads `<path>/config.json`.
It needs a **flat** directory:

```
~/models/Qwen3.5-27B-4bit/
├── config.json            ← must be here, at the top level
├── model-0000X-of-…safetensors
├── tokenizer.json …
```

A bare `hf download <repo>` (no `--local-dir`) instead produces a **cache tree**:

```
~/models/Qwen3.5-27B-4bit/
├── blobs/  refs/  snapshots/<hash>/config.json   ← no top-level config.json
```

With a cache tree, the server starts and `/v1/models` answers, but the model
loads lazily in a worker thread that dies with `FileNotFoundError` — so **every
prompt hangs forever with no output**. `bootstrap-mac.sh` avoids this by using
`--local-dir` (flat). If you download a model by hand, always pass `--local-dir`:

```bash
hf download <repo> --local-dir ~/models/<name>
```

The thinking launcher now fails fast with a clear message if it's pointed at a
cache tree, instead of hanging.

---

## Patched mlx-lm

The server runs a **patched** `mlx-lm`, editable-installed into the venv from
`~/src/mlx-lm` (branch `pi-tools-patched`). Two upstream PRs are required:

| PR | Fixes |
|----|-------|
| **#1277** (`fix-think-state-user-content`) | Bounds the `<think>` scan to the assistant prefill tail, so reasoning is split into `message.reasoning` and user messages containing literal `<think>` don't misroute output. Essential for the thinking model. |
| **#1249** (`fix/adapter-path`) | Fixes `--adapter-path` being silently ignored at startup (sft track). |

`bootstrap-mac.sh` clones, patches, and installs this automatically; the
`server/upgrade.sh` refresh keeps it current. Verify the venv imports the
patched build (not PyPI):

```bash
~/.pi/agent/venv/bin/python -c 'import mlx_lm,pathlib;print(pathlib.Path(mlx_lm.__file__).resolve().parent)'
# → /Users/<you>/src/mlx-lm/mlx_lm
```

If that prints a site-packages path, re-run `bootstrap-mac.sh`.

---

## Upgrading from `main`

To pull the latest pi-tools and refresh everything (idempotent, preserves your
`~/.pi` settings):

```bash
cd ~/src/pi-tools
git checkout main
bash server/upgrade.sh
```

`upgrade.sh` fast-forwards `main`, re-runs `bootstrap-mac.sh` (refreshing the
patched mlx-lm + venv, recreating the venv if it went missing, skipping
already-present model downloads), re-runs `install.sh` in **merge mode** (your
`models.json` / `settings.json` are backed up, not clobbered), verifies the
patched build, and restarts the server. It refuses to run on a dirty working
tree and never stashes/resets your changes.

---

## Hardware notes (< 64 GB hosts)

On hosts with < 64 GB unified memory the launcher auto-lowers the server budget
(`--max-tokens 4096`, `--prompt-cache-bytes 512 MiB`) to avoid
`[metal::malloc] Resource limit exceeded`. Override per-run if you have headroom:

```bash
MAX_TOKENS=8192 PROMPT_CACHE_BYTES=1073741824 bash server/mlx-server.sh up thinking
```

The 32 GB envelope for the thinking model is comfortable (≈11–14 GB resident).
Running the sft track's adapters alongside is not — see `M2-MAX-32GB-FINDINGS.md`.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Prompt hangs, no output, GPU idle | Model dir is an HF cache tree. Ensure top-level `config.json`; re-download with `--local-dir`. |
| `[metal::malloc] Resource limit exceeded` / empty replies | Lower `MAX_TOKENS` / `PROMPT_CACHE_BYTES` (auto-tuned on < 64 GB). |
| `venv ... missing` | Run `bash server/bootstrap-mac.sh`. |
| `/v1/models` lists the model but generation hangs | Same as the cache-tree case — `/v1/models` only scans metadata; the load happens on first generation. |
| Reasoning text leaks into the reply | venv isn't running the PR #1277 patch — re-run bootstrap and verify the import path above. |

---

## Legacy sft track (opt-in)

The Qwen3-Coder-30B-A3B base + LoRA adapters (proxy on :18080) is for adapter
work, not normal use:

```bash
bash server/bootstrap-mac.sh --with-sft     # downloads the ~16 GB base
bash server/mlx-server.sh up sft
```

See [`../MODELS.md`](../MODELS.md) and [`../server/HEALTH.md`](../server/HEALTH.md).

## 80B session track (opt-in)

The 80B agentic coder (Qwen3-Coder-Next-80B-A3B, 8-bit) drives *interactive*
pi sessions via the `local-mlx-80b` provider on `:18130`. It is a separate,
heavy track from the default 27B and is launched directly:

```bash
bash server/session-80b/launch.sh           # start (downloads ~83 GB on first run)
curl -sS http://localhost:18130/v1/models | jq .
bash server/session-80b/launch.sh stop
```

> **Memory — 128 GB-class hosts only.** The 80B is ~50 GB resident in
> typical use (MLX mmaps the weights; cold MoE experts stay on disk), up to
> ~83 GB worst case. The 27B `thinking` track can stay up alongside it, but
> run **one heavy track at a time** — do not also run the sft / extra-models
> tracks while the 80B is up. It also needs the patched venv mlx-lm (it
> emits Qwen3-Coder XML tool calls, which an unpatched server drops).

See [`../server/HEALTH.md`](../server/HEALTH.md) for the runbook.
