# pi-tools

Pi-native port of the orchestrator / manager / worker / adversary agent system
from [claude-tools-library](https://github.com/eilidhmae/claude-tools-library),
adapted for `pi-coding-agent` running against a local MLX inference stack.

Built and primarily tested on Apple M5 Max / 128 GB; runs on smaller Apple
Silicon too (the install auto-tunes on < 64 GB hosts). The default deployment is
the **thinking-adversary** track: one `mlx_lm.server` serving **Qwen3.5-27B-4bit**
at `127.0.0.1:18080`. A legacy Ollama / `qwen3-coder` adapter track is opt-in.

> **New machine?** Follow
> [`docs/ONBOARDING-APPLE-SILICON.md`](docs/ONBOARDING-APPLE-SILICON.md) — it
> covers the `~/models` layout, the patched mlx-lm, and the upgrade path.

## What this is

A multi-agent hierarchy (orchestrator → managers → workers / adversaries) that
preserves the original library's authority-separation model while mapping each
component onto pi's native primitives.

| Claude Code concept             | Pi equivalent                                    |
|---------------------------------|--------------------------------------------------|
| `.claude/agents/` frontmatter   | `skills/` + `AGENTS.md`                          |
| `/adversary-review` slash cmd   | `prompts/adversary-review.md`                    |
| PostToolUse hook                | `extensions/adversary-hook.ts` (`agent_end`)     |
| `_shared.md` bootstrap          | `AGENTS.md` (auto-loaded every session)          |
| Subagent spawn (Agent tool)     | RPC subprocess via `extensions/quorum.ts`        |

## Repo layout

```
pi-tools/
├── AGENTS.md                         # shared rules, loaded every session
├── README.md
├── install.sh                        # global or project-local installer
├── skills/
│   ├── adversary/SKILL.md            # /skill:adversary
│   ├── manager/SKILL.md              # /skill:manager
│   ├── orchestrator/SKILL.md         # /skill:orchestrator
│   └── worker/SKILL.md               # /skill:worker
├── prompts/
│   └── adversary-review.md           # /adversary-review
├── MODELS.md                         # adapter operator entry point
├── model-plan.md                     # full LoRA pipeline design
├── extensions/
│   ├── adversary-hook.ts             # post-write mechanical check
│   ├── quorum.ts                     # adversary quorum via RPC
│   └── lib/                          # library modules — not pi extensions
│       ├── adapter-route.ts          # (role, domain) → model id
│       ├── adversary-parse.ts        # YAML fence parser for adversary output
│       └── adversary-capture.ts      # tier-classified training-example capture
├── scripts/bash/
│   ├── adversary-check.sh            # mechanical baseline (no LLM, exits 0)
│   ├── adversary-pass.sh             # headless adversary pipeline
│   └── gen-review-revise.sh          # generate → review → revise cycle
└── server/                           # local MLX/MOLA inference launch tooling
    ├── README.md                     # server overview + first-time setup
    ├── HEALTH.md                     # operator runbook, fallback criteria
    ├── bootstrap-mac.sh              # one-shot M5 Max setup
    ├── models.json.template
    ├── mlx-server.sh                 # operator entry point: up/down/status
    │                                 # for Qwen track + configured extras
    ├── mlx-lm-multi/                 # default Qwen track (one process per adapter)
    ├── mola/                         # opt-in Qwen track (one base, many adapters)
    └── extra-models/                 # config-driven side-by-side mlx_lm.servers
        ├── README.md                 # how to add a contrast model
        └── config.conf               # <short-name> <port> <hf-repo-id> rows
```

## Install

### Global (all projects)

```bash
bash install.sh
```

Writes to `~/.pi/agent/`:

```
~/.pi/agent/
├── AGENTS.md
├── models.json                       # created/merged; local-mlx + thinking-model default
├── skills/{adversary,manager,orchestrator,worker}/SKILL.md
├── prompts/adversary-review.md
├── extensions/{adversary-hook,quorum}.ts
└── tools/{adversary-check,adversary-pass,gen-review-revise}.sh
```

### Project-local

```bash
bash install.sh --local
```

Same files, but under `.pi/agent/` in the current git repo root. Shell scripts
go to `scripts/bash/` under the repo root (not inside `.pi/agent/`).

### Force overwrite

```bash
bash install.sh --force
```

## Running a contrast model for heterogeneous quorum

`server/mlx-server.sh` brings up the standard Qwen `mlx-lm-multi`
stack **and** any side-by-side `mlx_lm.server` processes declared in
`server/extra-models/config.conf` (a `<short-name> <port>
<hf-repo-id>` row per contrast model, same shape as
`mlx-lm-multi/adapters.conf`). Operators wire a matching
`local-mlx-<short-name>` provider in `models.json`; with both servers
up, `adversary-pass.sh` can be invoked twice on the same artifact —
once via the default Qwen provider, once via
`--provider local-mlx-<short-name>` — for a two-model heterogeneous
review until shell `--quorum` learns to honour `PI_QUORUM_MODELS`.

Quick start:

```bash
bash server/mlx-server.sh up                  # Qwen + all uncommented extras
bash server/mlx-server.sh list                # configured tracks
bash server/mlx-server.sh status              # listeners + health
```

The Qwen proxy hardcodes its base id, so contrast models can't slot
in behind it — they run on their own ports (`:18100+`) and pi talks to
them directly via the sibling provider entry. See
`server/extra-models/README.md` for adding a contrast model and the
`models.json` provider snippet.

Workstation-specific config: point `PI_EXTRA_CONF` at a checkout-local
config file (e.g. a wrapper in your dotfiles) to keep per-workstation
model choices out of the pi-tools tree.

## Git hooks (this repo)

`hooks/` contains pre-commit, post-commit, and pre-push hooks that gate
this clone with the adversary harness. Install once per clone:

```bash
bash hooks/install.sh
```

What they do:

- **pre-commit** (fast, mechanical) — blocks on merge-conflict markers
  and `bash -n` failures on staged `*.sh`; runs
  `~/.pi/agent/scripts/adversary-check.sh` for an informational mechanical
  report; warns on large additions and new TODO/FIXME lines.
  Bypass: `git commit --no-verify` (discouraged).
  Skip just the adversary-check: `PI_SKIP_ADVERSARY_CHECK=1`.
- **post-commit** (capture-shaped, non-blocking) — runs
  `~/.pi/agent/scripts/adversary-scan.sh --range HEAD~..HEAD` in the
  background after every commit lands, writing the review to
  `reviews/post-commit-<sha>-<ts>.log` and appending a record to
  `~/.pi/agent/training/adversary-captures/bootstrap.jsonl`. The hook
  prints one line and exits immediately; the scan continues async.
  Skips merge commits, root commits, and messages containing
  `[skip scan]` / `[no scan]`. Disable per-commit with
  `PI_SKIP_POST_COMMIT_SCAN=1` or `git commit --no-verify`.
- **pre-push** (heavy, LLM, gate) — runs
  `~/.pi/agent/scripts/adversary-scan.sh --range <range> --gate` per ref.
  FAIL verdict blocks the push; CONCERNS prints findings + review path
  and lets the push through. New-branch pushes anchor on `origin/main`,
  so run `git fetch origin` if the remote-tracking ref is missing.
  No env-var bypass; mandatory gate.

Reviews land under `pi-tools/reviews/<basename>-<timestamp>.md`
(per-file scans) or `pi-tools/reviews/post-commit-<sha>-<ts>.log`
(post-commit captures).

## Models

- **Default — thinking-adversary (Apple Silicon):** one `mlx_lm.server`
  serving **Qwen3.5-27B-4bit** (a reasoning model) at `127.0.0.1:18080`,
  zero-shot, no adapters. Model + HF cache live under `~/models`
  (`HF_HOME=~/models`); served via the **patched** mlx-lm (PR #1277/#1249).
  Set up by `server/bootstrap-mac.sh`; run with `server/mlx-server.sh up thinking`.
- **Legacy sft track (opt-in):** `qwen3-coder-30b-a3b` (4-bit MLX, MoE,
  non-thinking) + hot-swappable LoRA adapters (`+go`, `+rust`, `+python`,
  `+tf`, `+adversary`) behind a proxy on :18080. Enable with
  `bootstrap-mac.sh --with-sft` then `mlx-server.sh up sft`.
- **Ollama (`qwen3-coder:30b`):** non-Apple fallback, no MLX requirement.

The harness is model-agnostic: selection flows through `--model` and
`models.json`. `install.sh` creates/merges `~/.pi/agent/models.json` and sets
the thinking model as the default, respecting any settings you already have.

See [`docs/ONBOARDING-APPLE-SILICON.md`](docs/ONBOARDING-APPLE-SILICON.md) for
setup, [`MODELS.md`](MODELS.md) for the adapter operator guide, and
[`model-plan.md`](model-plan.md) for design rationale.

## Upgrading

```bash
cd ~/src/pi-tools && git checkout main && bash server/upgrade.sh
```

`server/upgrade.sh` fast-forwards `main`, refreshes the patched mlx-lm + venv
(re-running `bootstrap-mac.sh`), re-installs the harness in **merge mode**
(your `models.json` / `settings.json` are backed up, not clobbered), verifies
the patched build, and restarts the server. It refuses to run on a dirty tree.

## Usage

```bash
# Self-review checklist (prompt command, runs in current session)
pi /adversary-review

# Full adversary skill, read-only
pi --tools read,grep,ls,bash --no-write --no-edit /skill:adversary

# Manager- or orchestrator-coordinated session
pi /skill:manager
pi /skill:orchestrator

# Headless adversary pipeline
bash ~/.pi/agent/scripts/adversary-pass.sh src/auth.go

# Adversary pass with automatic quorum on CONCERNS/FAIL
bash ~/.pi/agent/scripts/adversary-pass.sh src/auth.go --quorum

# Full generate → adversary → revise cycle
bash ~/.pi/agent/scripts/gen-review-revise.sh specs/feature.md --revise
```

## Key design notes

- **`AGENTS.md` is the `_shared.md` equivalent.** Pi auto-loads it from
  `~/.pi/agent/AGENTS.md` and any project-local `.pi/agent/AGENTS.md` every
  session. It carries Startup Reads, the Mechanical Baseline, Mutation-
  Verification Safety, Enqueue-Before-Ack, and resource ceilings.
- **No `CLAUDE.md`.** Per-project context lives in `PROJECT.md`, which the
  orchestrator creates on first run. Shared rules stay in `AGENTS.md`.
- **Tool enforcement at the harness level.** The adversary skill is always
  invoked with `--no-write --no-edit`; read-only authority is mechanical, not
  just prompt convention.
- **Quorum via RPC, not shell loops.** `extensions/quorum.ts` intercepts
  CONCERNS/FAIL verdicts and spawns peer adversary sessions as pi RPC
  subprocesses — no outer shell harness required.
- **`adversary-check.sh` is unchanged** from the original library and runs
  identically via the `bash` tool.

## Source

Ported from <https://github.com/eilidhmae/claude-tools-library>.
