# pi-tools

Pi-native port of the orchestrator / manager / adversary agent system for
`pi-coding-agent` + Ollama + qwen3-coder.

## Purpose

This repo holds the flat source files for the pi-agents-library. A Claude Code
session should scaffold these into the target directory structure (see below)
and wire up the install script.

## Target Structure (post-install)

```
~/.pi/agent/                          # global install target
├── AGENTS.md                         # shared rules — loaded every session
├── models.json                       # ollama provider config
├── skills/
│   ├── adversary/SKILL.md            # /skill:adversary  ← adversary-SKILL.md
│   ├── manager/SKILL.md              # /skill:manager    ← manager-SKILL.md
│   ├── orchestrator/SKILL.md         # /skill:orchestrator ← orchestrator-SKILL.md
│   └── worker/SKILL.md               # /skill:worker     ← worker-SKILL.md
├── prompts/
│   └── adversary-review.md           # /adversary-review ← adversary-review.md
├── extensions/
│   ├── adversary-hook.ts             # post-write mechanical check
│   └── quorum.ts                     # adversary quorum via RPC
└── tools/
    ├── adversary-check.sh            # mechanical baseline (no LLM, exits 0)
    ├── adversary-pass.sh             # headless adversary pipeline
    └── gen-review-revise.sh          # generate → review → revise cycle
```

Project-local install target (--local flag):
```
.pi/agent/                            # same structure under repo root
tools/bash/                           # shell scripts here for project-local
```

## Source Files in This Repo

| File | Installs to | Purpose |
|------|-------------|---------|
| `AGENTS.md` | `~/.pi/agent/AGENTS.md` | Shared rules (_shared.md equivalent) |
| `adversary-SKILL.md` | `~/.pi/agent/skills/adversary/SKILL.md` | Adversary role |
| `manager-SKILL.md` | `~/.pi/agent/skills/manager/SKILL.md` | Manager role |
| `orchestrator-SKILL.md` | `~/.pi/agent/skills/orchestrator/SKILL.md` | Orchestrator role |
| `worker-SKILL.md` | `~/.pi/agent/skills/worker/SKILL.md` | Worker role |
| `adversary-review.md` | `~/.pi/agent/prompts/adversary-review.md` | `/adversary-review` command |
| `adversary-hook.ts` | `~/.pi/agent/extensions/adversary-hook.ts` | PostWrite extension |
| `quorum.ts` | `~/.pi/agent/extensions/quorum.ts` | Quorum extension |
| `adversary-check.sh` | `~/.pi/agent/tools/adversary-check.sh` | Mechanical baseline |
| `adversary-pass.sh` | `~/.pi/agent/tools/adversary-pass.sh` | Adversary pipeline |
| `gen-review-revise.sh` | `~/.pi/agent/tools/gen-review-revise.sh` | Full pipeline |
| `install.sh` | run from repo root | Installer |

## Install

```bash
# Global (all projects)
bash install.sh

# Project-local
bash install.sh --local

# Force overwrite
bash install.sh --force
```

## Model

qwen3-coder:30b via Ollama. Non-thinking mode only — no `<think>` blocks.
The step-by-step structure in each SKILL.md is the reasoning scaffold.

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
# Self-review checklist
pi /adversary-review

# Full adversary skill
pi --tools read,grep,ls,bash --no-write --no-edit /skill:adversary

# Headless adversary pipeline
bash ~/.pi/agent/tools/adversary-pass.sh src/auth.go

# With quorum
bash ~/.pi/agent/tools/adversary-pass.sh src/auth.go --quorum

# Full generate → review → revise
bash ~/.pi/agent/tools/gen-review-revise.sh specs/feature.md --revise
```

## Source Repo

Ported from: https://github.com/eilidhmae/claude-tools-library
