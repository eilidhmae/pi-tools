# pi-agents-library

A pi-native port of the orchestrator / manager / adversary agent system from
[claude-tools-library](https://github.com/eilidhmae/claude-tools-library),
adapted for `pi-coding-agent` + Ollama + qwen3-coder on macOS.

## What this is

The original system is a coordinating multi-agent hierarchy (orchestrator →
managers → workers / adversaries) designed for Claude Code's `Agent` tool and
subagent spawning. This port preserves the same authority-separation model and
protocol semantics while mapping each component to pi's native primitives:

| Claude Code concept | Pi equivalent |
|---------------------|---------------|
| Agent frontmatter + `.claude/agents/` | `skills/` + `AGENTS.md` |
| `/adversary-review` slash command | `prompts/adversary-review.md` (`/adversary-review`) |
| PostToolUse hook | `extensions/adversary-hook.ts` (`agent_end` event) |
| `_shared.md` Prime Directive bootstrap | `AGENTS.md` global context (loaded every session) |
| Subagent spawn (Agent tool) | RPC subprocess via `extensions/quorum.ts` |
| `adversary-check.sh` | `tools/bash/adversary-check.sh` (identical, unchanged) |

## Structure

```
pi-agents-library/
├── README.md
├── AGENTS.md                        # Global startup context (→ ~/.pi/agent/AGENTS.md)
├── install.sh                       # Installer: global or project-local
├── skills/
│   ├── adversary/
│   │   └── SKILL.md                 # /skill:adversary
│   ├── manager/
│   │   └── SKILL.md                 # /skill:manager
│   ├── orchestrator/
│   │   └── SKILL.md                 # /skill:orchestrator
│   └── worker/
│       └── SKILL.md                 # /skill:worker
├── prompts/
│   └── adversary-review.md          # /adversary-review command
├── extensions/
│   ├── adversary-hook.ts            # PostWrite mechanical check (agent_end)
│   └── quorum.ts                    # Adversary quorum via RPC subprocesses
└── tools/
    └── bash/
        └── adversary-check.sh       # Mechanical baseline (no LLM, always exits 0)
```

## Install

### Global (all projects)

```bash
bash install.sh
```

Writes to:
- `~/.pi/agent/AGENTS.md`
- `~/.pi/agent/skills/{adversary,manager,orchestrator,worker}/SKILL.md`
- `~/.pi/agent/prompts/adversary-review.md`
- `~/.pi/agent/extensions/adversary-hook.ts`
- `~/.pi/agent/extensions/quorum.ts`
- `~/.pi/agent/tools/adversary-check.sh`

### Project-local

```bash
bash install.sh --local
```

Writes same files under `.pi/` in the current git repo root.

### Force overwrite

```bash
bash install.sh --force
```

## Usage

### Adversary self-check (prompt command)

```
/adversary-review
```

Runs the full adversarial self-review checklist in the current session
context. Lighter-weight than spawning a full skill:adversary session.

### Adversary one-shot (read-only, tool-constrained)

```bash
cat skills/adversary/SKILL.md | pi \
  --tools read,grep,ls,bash \
  --no-write --no-edit \
  -p "review @path/to/file.go"
```

### Full adversary pass with quorum (shell pipeline)

```bash
bash tools/bash/adversary-pass.sh src/auth.go
```

Runs adversary skill, captures verdict, spawns peer quorum if CONCERNS/FAIL,
writes review artifacts to `reviews/`.

### Adversary pass with automatic revision

```bash
bash tools/bash/adversary-pass.sh src/auth.go --revise
```

### Generate → adversary → revise cycle

```bash
bash tools/bash/gen-review-revise.sh specs/feature.md
```

### Manager-coordinated session

```
/skill:manager
```

Activates the manager role in the current pi session. The manager reads
`AGENTS.md` and any project `CLAUDE.md` on startup, then follows the
decompose → delegate → verify → document workflow.

## Models

Configured for Ollama + qwen3-coder. The `qwen3-coder:30b` variant (3.3B
activated, 30B total, MoE) is the recommended local model — strong tool-calling,
non-thinking mode only, 262K context.

`models.json` snippet:

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        { "id": "qwen3-coder:30b" },
        { "id": "qwen3-coder-next" }
      ]
    }
  }
}
```

## Key design decisions

**Quorum via RPC, not shell loops.** The `extensions/quorum.ts` extension
intercepts CONCERNS/FAIL verdicts and spawns peer adversary sessions as pi RPC
subprocesses. This keeps quorum entirely within the pi extension system rather
than requiring an outer shell harness.

**Tool enforcement at the harness level.** The adversary skill is always invoked
with `--no-write --no-edit`. This enforces read-only authority mechanically, not
just by prompt convention.

**AGENTS.md is the `_shared.md` equivalent.** Pi auto-discovers `AGENTS.md`
from `~/.pi/agent/` and the current project directory, loading it into every
session's context. It carries the Mechanical Baseline, Startup Reads,
Enqueue-Before-Ack, Mutation Verification Safety, and resource ceilings.

**`adversary-check.sh` is unchanged.** The bash script from the original
library runs identically in pi sessions via the `bash` tool. No adaptation
needed.
