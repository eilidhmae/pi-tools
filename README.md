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
├── extensions/
│   ├── adversary-hook.ts             # post-write mechanical check
│   └── quorum.ts                     # adversary quorum via RPC
└── tools/bash/
    ├── adversary-check.sh            # mechanical baseline (no LLM, exits 0)
    ├── adversary-pass.sh             # headless adversary pipeline
    └── gen-review-revise.sh          # generate → review → revise cycle
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
go to `tools/bash/` under the repo root (not inside `.pi/agent/`).

### Force overwrite

```bash
bash install.sh --force
```

## Model

qwen3-coder:30b via Ollama (3.3B activated, 30B total, MoE — strong tool-calling,
262K context). Non-thinking mode only — no `<think>` blocks; the step-by-step
structure inside each `SKILL.md` is the reasoning scaffold.

`install.sh` creates `~/.pi/agent/models.json` with ollama defaults if one does
not already exist:

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        { "id": "qwen3-coder:30b" },
        { "id": "qwen3-coder-next" }
      ]
    }
  }
}
```

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
bash ~/.pi/agent/tools/adversary-pass.sh src/auth.go

# Adversary pass with automatic quorum on CONCERNS/FAIL
bash ~/.pi/agent/tools/adversary-pass.sh src/auth.go --quorum

# Full generate → adversary → revise cycle
bash ~/.pi/agent/tools/gen-review-revise.sh specs/feature.md --revise
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
