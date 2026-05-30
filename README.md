# pi-tools

Pi-native port of the orchestrator / manager / worker / adversary agent system
from [claude-tools-library](https://github.com/eilidhmae/claude-tools-library),
adapted for `pi-coding-agent` + Ollama + qwen3-coder.

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
├── models.json                       # created if absent; ollama defaults
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

Two runtime paths over the **same** underlying model — Qwen3-Coder
30B-A3B (MoE, 3B activated of 30B total, 262K context, non-thinking
mode only):

- **Existing (default)**: `qwen3-coder:30b` via Ollama. Strong
  tool-calling, no Apple-Silicon requirement.
- **New (M5 Max + Apple Silicon)**: `qwen3-coder-30b-a3b` (4-bit MLX)
  with hot-swappable LoRA adapters (`+go`, `+rust`, `+python`, `+tf`,
  `+adversary`) served via `mlx_lm.server` or MOLA on `localhost:18080`.

The harness is adapter-agnostic: model selection flows through `--model`
and `models.json`. Today's Ollama users see no behavior change.

See [`MODELS.md`](MODELS.md) for the operator entry point (where adapter
artifacts live, how to run pi with each one, dogfood procedure) and
[`model-plan.md`](model-plan.md) for the full design rationale.

`install.sh` creates `~/.pi/agent/models.json` with both providers
(ollama + local-mlx) if one does not already exist. The local-mlx
provider points at the inference server in [`server/`](server/).

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
