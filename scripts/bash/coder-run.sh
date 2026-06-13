#!/usr/bin/env bash
#
# coder-run.sh -- Run a TOOL-ENABLED implementation worker that WRITES THE REAL
# repository (NOT a research jail).
#
# This is the implementing sibling of plan-jailed.sh / research-jailed.sh. Where
# those run a read-only worker inside the research-mode jail and stage artifacts
# to a workspace, this worker reads the plan + target sources and writes SOURCE
# INTO THE REAL REPO. Its safety is the confinement of the session it runs in
# (ideally the container-harness), not a jail:
#
#   - tools: read, grep, find, ls, write, edit, bash  (full implement authority)
#   - NO --research (research mode is read-only; there is no writable session
#     path there). This script FAILS HARD if invoked from a research-mode
#     session — see the guard below.
#   - only the qwen25coder-toolcall extension is loaded (-e). That is the crux:
#     the 32B dense coder emits tool calls in a wrapper the backend parser drops,
#     so without this extension its tool calls never dispatch and it cannot act
#     as an agentic worker at all. Loading only that one extension also keeps the
#     turn lean (no quorum/adversary-hook).
#
# The worker's system prompt is the `worker` skill (TDD: write a failing test,
# implement, run the test, report the evidence).
#
# Usage:
#   coder-run.sh "<prompt>"                 # run an implementation task
#   coder-run.sh "<prompt>" --label <slug>  # tag the run (informational)
#
# There is no workspace/reports dir and no "Report written to:" line — the
# deliverable is the working-tree change itself. After the run this script
# prints a READ-ONLY change summary (git diff --stat + git status --short) the
# coordinator can gate on. It NEVER reverts the working tree (no
# checkout/restore/reset/stash) — mutation-verification safety.
#
# Output: the worker's combined stdout/stderr, then the change summary.
# Always exits 0 after a completed run (informational, not a gate); the guard
# failures below exit non-zero.

set -euo pipefail

# --- Research-mode fail-hard (belt-and-suspenders with the tool guard) ---
# The implementor writes the real repo; research mode is read-only and offers no
# writable session path. Refuse loud rather than silently dry-run into a
# workspace and look like it implemented something.
if [[ -n "${PI_RESEARCH_WORKSPACE:-}" || -n "${PI_RESEARCH_MODE_WORKSPACE:-}" ]]; then
  echo "ERROR: no writable session path; exit research-mode to implement" >&2
  exit 3
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PROMPT="${1:?Usage: coder-run.sh \"<prompt>\" [--label <slug>]}"
shift

LABEL="coder"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --label) LABEL="${2:?--label needs a slug}"; shift ;;
    *)       echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

# --- Model / provider (Apple-Silicon / 32B only; no fallback) ---
# The provider/model ids are load-bearing: the toolcall-repair extension only
# fires when the model id equals its TARGET_MODEL_ID, so these must match
# exactly.
if [[ "$(uname -m)" != "arm64" ]]; then
  echo "ERROR: coder-run.sh requires Apple Silicon (arm64) — the 32B Code Worker" >&2
  echo "       is served only on this host. No non-arm64 fallback." >&2
  exit 2
fi
PROVIDER="local-mlx-qwen25coder32b"
# Pinned, NOT overridable: the toolcall-repair extension fires only when the
# model id equals its TARGET_MODEL_ID byte-for-byte. Any other value silently
# disables the repair (tool calls leak as text, the worker stalls with no
# diagnostic), and there is no other model on :18111 — so there is no safe
# non-default value. Repointing requires editing this id AND the extension's
# TARGET_MODEL_ID together.
MODEL="mlx-community/Qwen2.5-Coder-32B-Instruct-8bit"
if ! curl -fs --max-time 3 http://localhost:18111/v1/models >/dev/null 2>&1; then
  echo "ERROR: backend http://localhost:18111 unreachable. Bring it up:" >&2
  echo "         bash <pi-tools>/server/mlx-server.sh up"                 >&2
  exit 2
fi

# --- Resolve the worker skill (sole system prompt) ---
WORKER_SKILL="${HOME}/.pi/agent/skills/worker/SKILL.md"
[[ -f "$WORKER_SKILL" ]] || WORKER_SKILL="skills/worker/SKILL.md"
if [[ ! -f "$WORKER_SKILL" ]]; then
  echo "ERROR: worker SKILL.md not found (run install.sh)." >&2
  exit 1
fi

# --- Resolve the toolcall-repair extension (the crux: makes the 32B dispatch) ---
TOOLCALL_EXT="${HOME}/.pi/agent/extensions/qwen25coder-toolcall.ts"
[[ -f "$TOOLCALL_EXT" ]] || TOOLCALL_EXT="extensions/qwen25coder-toolcall.ts"
if [[ ! -f "$TOOLCALL_EXT" ]]; then
  echo "ERROR: qwen25coder-toolcall.ts not found (run install.sh). Without it the" >&2
  echo "       32B's tool calls never dispatch and it cannot implement." >&2
  exit 1
fi

# LABEL is informational here (no artifact named after it); keep it sanitized
# for any downstream use without enforcing a file convention.
LABEL_SLUG=$(echo "$LABEL" | tr '/ ' '__' | tr -cd 'A-Za-z0-9._-')
[[ -z "$LABEL_SLUG" ]] && LABEL_SLUG="coder"

# Action-first framing. This dense non-thinking coder NARRATES instead of acting
# when handed a "report the TDD sequence" brief — it prints tool calls as fenced
# JSON examples (which the toolcall-repair extension correctly ignores) and
# writes nothing. Measured 2026-06-13: report-style wrapper → 0/3 runs wrote
# files; this imperative "make real tool calls, act don't describe" wrapper →
# 3/3 wrote files and ran tests. Keep it imperative; the report comes last and
# brief. (See the worker SKILL.md system prompt for the role contract.)
read -r -d '' FULL_PROMPT <<EOF || true
Implement the change described below in this repository. Do the work by making
real tool calls: use write/edit to change files and bash to run tests and
commands. Act — do not merely describe the steps, and do not put tool calls
inside markdown code blocks. Work test-first: add or update a test, run it and
watch it fail, then implement until it passes. Read the plan and any target
sources referenced in the task before changing them. When everything passes,
finish with a brief plain-text summary of the files you changed.

Task:
${PROMPT}
EOF

# NOT --research; full implement tools; only the toolcall-repair extension. The
# child writes the real working tree.
run_pi() {
  local prompt="$1"
  pi \
    --no-extensions \
    -e "$TOOLCALL_EXT" \
    --no-skills \
    --no-prompt-templates \
    --no-context-files \
    --no-session \
    --tools read,grep,find,ls,write,edit,bash \
    --provider "$PROVIDER" \
    --model "$MODEL" \
    --system-prompt "$(cat "$WORKER_SKILL")" \
    -p "$prompt" 2>&1
}

OUTPUT=$(run_pi "$FULL_PROMPT") || true

echo "$OUTPUT"
echo ""

# --- Read-only change summary for the coordinator to gate on ---
# NEVER revert the working tree here: no git checkout/restore/reset/stash.
echo "=== coder-worker change summary ==="
git -C "$PWD" --no-pager diff --stat
echo ""
git -C "$PWD" --no-pager status --short
exit 0
