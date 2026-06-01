# Agent Context

Loaded automatically by pi from `~/.pi/agent/AGENTS.md` and any project-local
`.pi/agent/AGENTS.md`. All agents in this system read this file as their shared
rule set. If this file is absent, agents proceed with degraded context and note
the absence in their completion report — they do not guess at the contents.

## Authority Separation

| Role | Authority | Writes | Delegates To |
|------|-----------|--------|--------------|
| Worker | One task, implementation only | Code, tests, per-task state | — |
| Adversary | Verification of one work unit (read-only) | Nothing | Peer adversaries (quorum) |
| Manager | Coordination of one lineage | Lineage drafts under `.pi/drafts/<LINEAGE_ID>/` (orchestrated) or canonical `PROJECT.md` / `CHANGELOG.md` / `TODO.md` (standalone) | Workers, adversaries, research subagents |
| Orchestrator | Cross-lineage observability, reconciliation, commits | Merged canonical docs, manager prompts, commit messages | Managers, research subagents |

The orchestrator is a centralized dispatcher with commit authority. This is a
deliberate deviation from Grail's decentralized model, justified by the bounded,
single-session nature of pi operation.

## Startup Reads

On every session start, in order:

1. Read `PROJECT.md` in the project root. If absent, the active agent follows
   its own spec for creating or proceeding without it.
2. Read every document `PROJECT.md` references, recursively.
3. Read `CHANGELOG.md` and `TODO.md` if they exist.
4. Run `git log --oneline -20` and `git status`.
5. Run the Mechanical Baseline (see below).

Before accepting any goal, hold a clear internal picture of project
architecture, current state, recent commits, pending work, and any flags from
the Mechanical Baseline.

## Mechanical Baseline

Run when assessing project state — on startup, before commits, and during
adversary reviews:

```bash
bash scripts/bash/adversary-check.sh . || bash ~/.pi/agent/scripts/adversary-check.sh .
```

The script **always exits 0**. Findings are in stdout — do not gate on exit
code. Read the output and act on the flags it raises.

## Mutation Verification Safety

Applies to any agent running bash when verifying behaviour by mutating a file.

**Banned commands during mutation revert** (they operate on the whole working
tree and will destroy uncommitted edits from other work in the session):

- `git checkout -- <file>`
- `git checkout <ref> -- <file>`
- `git restore <file>`
- `git reset --hard` (any form)
- `git stash` (any form)

**Safe pattern:** apply the mutation with the `edit` tool, run the test to
confirm the expected failure or pass, then call `edit` again with the opposite
change to revert. Agents without write access do not perform mutations; they
report what must be demonstrated and the manager dispatches a worker.

## Enqueue-Before-Ack

Persist next-actions before closing the current one. Update `TODO.md` with
follow-up tasks and append to `CHANGELOG.md` **before** marking work as done
or committing.

Rationale: if an agent closes a task and then fails before recording the
follow-up, the follow-up is lost silently. Ordering the writes the other way —
persist next, then close current — ensures a crash between the two steps leaves
the current task re-runnable rather than losing branches of work.

## Adapter-Scoped Authority

Model selection is orthogonal to role. The orchestrator, manager, worker,
and adversary roles are defined by skill prompts and harness flags
(`--no-write --no-edit` for adversary, etc.). The model id determines
*what the agent knows about*, not *what it is allowed to do*.

Two layers compose:

| Layer        | What it controls                                       | Source of truth                          |
| ------------ | ------------------------------------------------------ | ---------------------------------------- |
| Role         | tool restrictions, prompt scaffolding                  | `skills/<role>/SKILL.md`                 |
| Adapter      | language/domain specialization of the underlying LLM   | `extensions/lib/adapter-route.ts` + `MODELS.md` |

The orchestrator never selects an adapter for itself — it runs on the bare
`qwen3-coder-30b-a3b` (or `qwen3-coder:30b` on the legacy Ollama path) so that
its broad coverage is preserved for cross-lineage reasoning. Managers
and workers may run with any adapter. Adversaries can run with the
`+adversary` adapter via the `--adapter` flag in `adversary-pass.sh` (or
`--model qwen3-coder-30b-a3b+adversary` directly); this is operator-opted-in
and the harness does not auto-detect or auto-switch.

The pi harness reads the model id from `--model` and routes via
`models.json`. Today's Ollama-only deployments are unaffected: skip the
`local-mlx` provider entirely and the routing degrades to the existing
`qwen3-coder:30b` flow.

See `MODELS.md` for the operator guide and `model-plan.md` for the full
design rationale.

## Lineage-Scoped Writes

When a manager's dispatch prompt contains a `LINEAGE_ID`, the manager's writes
to project-level documents are scoped to that lineage's draft directory:

- `PROJECT.md` updates → `.pi/drafts/<LINEAGE_ID>/PROJECT-patch.md`
- `CHANGELOG.md` entries → `.pi/drafts/<LINEAGE_ID>/CHANGELOG-entries.md`
- `TODO.md` updates → `.pi/drafts/<LINEAGE_ID>/TODO-updates.md`

The orchestrator merges drafts into canonical files at reconciliation, then
deletes the drafts directory.

When no `LINEAGE_ID` is present (standalone manager), the manager writes
directly to the canonical files.

**File shapes for deterministic merge:**

- `CHANGELOG-entries.md` — each entry preceded by `## <ISO-8601 completion
  timestamp>` for ordering. Timestamp captured at draft-write time
  (`date -u +%Y-%m-%dT%H:%M:%SZ`), not worker finish time.
- `TODO-updates.md` — two sections: `### Move to Done` and `### Add to Active`,
  one bullet per item.
- `PROJECT-patch.md` — free-form prose describing the proposed change; the
  orchestrator applies with judgment.

## Payload-by-Reference

When briefing a worker, adversary, or manager, cite file paths, line numbers,
and commit SHAs. Do not paste file contents inline unless the snippet is short
and the reader would otherwise need to read an outsized file for a single line
of context.

Rationale: inline state grows with task count and burns context proportionally.
A path reference is O(1) in prompt size regardless of project size.

## Known Limitations and Resource Ceilings

- **Re-dispatch cap (orchestrator):** at most 2 retries per goal (3 attempts
  total). Hitting the cap triggers escalation to human.
- **Adversary cap (manager):** at most 3 manager-spawned adversaries per work
  unit. The adversary's own internal peer quorum (via `extensions/quorum.ts`)
  is independent and capped at 3 total reviewers.
- **Worker fanout (manager):** at most 6 parallel workers per dispatch wave.
  If decomposition requires more, serialize waves.
- **Observability:** no persistent event log across sessions beyond
  `CHANGELOG.md` and git history.

## Pi-Specific Notes

**Tool enforcement:** the adversary skill is always invoked with
`--no-write --no-edit` at the harness level. The `--tools read,grep,ls,bash`
flag constrains what the model can call. Role definitions also prohibit writing,
but harness enforcement is the primary guarantee.

**Quorum:** handled by `extensions/quorum.ts`, which intercepts CONCERNS/FAIL
verdicts and spawns peer adversary sessions as pi RPC subprocesses. The
`QUORUM_PEER` token prevents recursion.

**Reasoning / `<think>` blocks:** the default model (Qwen3.5-27B, thinking
track) *does* emit `<think>` reasoning; the patched mlx-lm splits it into
`message.reasoning` rather than leaking it into `content` (see Inference Stack
below). The legacy sft model `qwen3-coder-30b-a3b` does *not* generate
`<think>` blocks — there the step-by-step structure in skill prompts is the
only reasoning scaffold.

## Inference Stack (local MLX)

Default deployment on Apple Silicon:

- **Server:** one `mlx_lm.server` (the *thinking-adversary* track) on
  `127.0.0.1:18080`, OpenAI-compatible. Up/down with
  `server/mlx-server.sh up|down thinking`. No proxy, no LoRA adapters.
- **Model:** `~/models/Qwen3.5-27B-4bit` (a reasoning model). The pi `local-mlx`
  provider and the `settings.json` default both point at this path — the id *is*
  the path, because the server resolves the request `model` as a filesystem path.
- **Models / cache:** everything lives under `~/models` (`HF_HOME=~/models`). A
  model dir must be FLAT (top-level `config.json`); an HF cache tree
  (`blobs/refs/snapshots/`) makes the server hang on first request.
- **Patched mlx-lm:** the venv (`~/.pi/agent/venv`) runs an editable build from
  `~/src/mlx-lm` carrying PR #1277 (think-state) + PR #1249 (adapter-path).
  `server/bootstrap-mac.sh` creates/patches it; `server/upgrade.sh` refreshes it.
- **Legacy sft track** (`qwen3-coder-30b-a3b` + adapters, proxy on :18080) is
  opt-in: `bootstrap-mac.sh --with-sft`, then `mlx-server.sh up sft`.

Troubleshooting (when a session hangs or errors):

- **Prompt hangs, zero output, GPU idle** → the model dir is likely an HF cache
  tree. Confirm `~/models/Qwen3.5-27B-4bit/config.json` exists at the top level;
  re-download flat with `hf download <repo> --local-dir <dir>`.
- **`[metal::malloc] Resource limit exceeded` / empty replies** → lower the
  server budget: `MAX_TOKENS=4096 PROMPT_CACHE_BYTES=536870912` (the launcher
  auto-tunes this on <64 GB hosts).
- **`venv ... missing`** → run `server/bootstrap-mac.sh`.
- Full setup & upgrade walkthrough: `docs/ONBOARDING-APPLE-SILICON.md`.

## Development Workflow

**Source of truth:** All development happens in this repository (`~/src/pi-tools`).

**Editing files:** Only edit files in this repository. Do NOT edit files in
`~/.pi/agent/` directly — those are managed by the install script.

**Testing changes:** After editing files, run:
```bash
./install.sh --force
```
This copies your changes to `~/.pi/agent/` for immediate testing.

**Keeping install.sh up-to-date:** When adding new files that should be installed:
1. Add the file to the appropriate section in `install.sh` (extensions, skills, tools, etc.)
2. Use the `install_file` helper function
3. Update the help text at the end of `install.sh` to document the new file
4. Test with `./install.sh --force` to verify it installs correctly

**File locations:**
- Extensions: `extensions/*.ts` → `~/.pi/agent/extensions/`
- Skills: `skills/<name>/SKILL.md` → `~/.pi/agent/skills/<name>/SKILL.md`
- Tools: `scripts/bash/*.sh` → `~/.pi/agent/scripts/`
- Documentation: `extensions/*.md` → `~/.pi/agent/extensions/`

**Example:** Adding a new extension:
```bash
# 1. Create the extension file
# extensions/my-new-extension.ts

# 2. Add to install.sh in the "=== Extensions ===" section:
# install_file \
#   "$SCRIPT_DIR/extensions/my-new-extension.ts" \
#   "$PI_AGENT_DIR/extensions/my-new-extension.ts"

# 3. Update the help text at the end of install.sh

# 4. Test
./install.sh --force
```

**Rollback:** If needed, revert changes in this repo and re-run install:
```bash
git checkout <file>
./install.sh --force
```
