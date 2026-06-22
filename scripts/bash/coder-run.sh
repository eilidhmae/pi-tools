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
#
# Three tiers, selected at RUNTIME by PI_CODER_TIER (no reinstall needed):
#
#   large (default): the 32B dense coder on :18111. Only the
#     qwen25coder-toolcall extension is loaded (-e). That is the crux on this
#     tier: the 32B emits tool calls in a wrapper the backend parser drops, so
#     without this extension its tool calls never dispatch and it cannot act as
#     an agentic worker at all. Loading only that one extension also keeps the
#     turn lean (no quorum/adversary-hook).
#   small: the 27B reasoning model on :18080 serves the Coder too (the 35GB 32B
#     can't co-reside with the resident 27B on a <112GB box). The 27B's tool
#     calls dispatch natively, so the toolcall-repair extension is NOT loaded
#     (it is a strict no-op for non-32B models anyway) — this branch runs pi
#     with no -e at all.
#   gemma: a REASONING alternate coder, Gemma-4-31B-it 8bit on :18112 (its own
#     port, never the :18111 slot). No toolcall-repair extension (different
#     model id; the ext no-ops for it, and Gemma emits native structured tool
#     calls). Thinking is ON by the model's own chat-template default — pi's
#     --thinking flag is a no-op for this provider (no thinkingFormat compat),
#     so it is not passed; reasoning:true in models.json makes pi parse the
#     think output. Same one-track-with-80B memory rule as the 32B.
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

# --- Tier select (Apple-Silicon only; no non-arm64 fallback on either tier) ---
# macOS reports arm64; the Linux container-harness guest reports aarch64 and
# reaches the host MLX backends via socat-forwarded ports. Accept both; only a
# genuinely other arch (x86) lacks a Code Worker backend.
if [[ "$(uname -m)" != "arm64" && "$(uname -m)" != "aarch64" ]]; then
  echo "ERROR: coder-run.sh requires Apple Silicon (arm64) or a Linux/aarch64" >&2
  echo "       container-harness guest forwarding to the host — the Code Worker" >&2
  echo "       backends are served only there." >&2
  exit 2
fi
CODER_TIER="${PI_CODER_TIER:-large}"
# Thinking level for the small/27B Coder path only (pi levels: off|minimal|low|
# medium|high|xhigh). Default OFF: the RPI Implementor is an executor — the
# deliberation is front-loaded into the (thinking) Planner — and thinking-off
# also avoids the 27B's single-shot <think> runaway. This is a measuring knob
# for whether thinking helps the coder hat; it ONLY touches the coder's own
# local-mlx-coder27b provider view, never the adversary/researcher/planner.
CODER_THINKING="${PI_CODER_THINKING:-off}"

case "$CODER_TIER" in
  large)
    # --- 32B dense coder on :18111 ---
    # The provider/model ids are load-bearing: the toolcall-repair extension only
    # fires when the model id equals its TARGET_MODEL_ID, so these must match
    # exactly.
    PROVIDER="local-mlx-coder32b"
    # Pinned, NOT overridable: the toolcall-repair extension fires only when the
    # model id equals its TARGET_MODEL_ID byte-for-byte. Any other value silently
    # disables the repair (tool calls leak as text, the worker stalls with no
    # diagnostic), and there is no other model on :18111 — so there is no safe
    # non-default value. Repointing requires editing this id AND the extension's
    # TARGET_MODEL_ID together.
    MODEL="mlx-community/Qwen2.5-Coder-32B-Instruct-8bit"
    CODER_PORT=18111
    ;;
  small)
    # --- 27B reasoning model on :18080 (serves the Coder on <112GB boxes) ---
    # The 27B's tool calls dispatch natively, so no toolcall-repair extension is
    # loaded on this path (see run_pi below). local-mlx-coder27b is the Coder's
    # OWN view of the same :18080 backend/weights as local-mlx, but flagged
    # thinking-controllable (reasoning + qwen-chat-template) — so toggling
    # thinking here never affects the adversary/researcher/planner, which use the
    # unchanged local-mlx provider (no kwarg sent → always thinking).
    PROVIDER="local-mlx-coder27b"
    MODEL="${HOME}/models/Qwen3.5-27B-4bit"
    CODER_PORT=18080
    ;;
  gemma)
    # --- Gemma-4-31B reasoning coder on :18112 (its own port) ---
    # No toolcall-repair extension (Gemma is a different model id and emits
    # native structured tool calls). Thinking is the model's default; see the
    # gemma branch in run_pi below.
    PROVIDER="local-mlx-gemma431b"
    MODEL="unsloth/gemma-4-31b-it-MLX-8bit"
    CODER_PORT=18112
    ;;
  *)
    echo "ERROR: PI_CODER_TIER must be 'large', 'small', or 'gemma' (got '${CODER_TIER}')." >&2
    exit 2
    ;;
esac

if ! curl -fs --max-time 3 "http://localhost:${CODER_PORT}/v1/models" >/dev/null 2>&1; then
  echo "ERROR: backend http://localhost:${CODER_PORT} unreachable. Bring it up:" >&2
  echo "         bash <pi-tools>/server/mlx-server.sh up"                         >&2
  exit 2
fi

# --- Resolve the worker skill (sole system prompt) ---
WORKER_SKILL="${HOME}/.pi/agent/skills/worker/SKILL.md"
[[ -f "$WORKER_SKILL" ]] || WORKER_SKILL="skills/worker/SKILL.md"
if [[ ! -f "$WORKER_SKILL" ]]; then
  echo "ERROR: worker SKILL.md not found (run install.sh)." >&2
  exit 1
fi

# --- Resolve the toolcall-repair extension (LARGE tier only: makes the 32B
# dispatch). The small/27B tier dispatches natively and loads no extension. ---
if [[ "$CODER_TIER" == "large" ]]; then
  TOOLCALL_EXT="${HOME}/.pi/agent/extensions/qwen25coder-toolcall.ts"
  [[ -f "$TOOLCALL_EXT" ]] || TOOLCALL_EXT="extensions/qwen25coder-toolcall.ts"
  if [[ ! -f "$TOOLCALL_EXT" ]]; then
    echo "ERROR: qwen25coder-toolcall.ts not found (run install.sh). Without it the" >&2
    echo "       32B's tool calls never dispatch and it cannot implement." >&2
    exit 1
  fi
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

# NOT --research; full implement tools. The child writes the real working tree.
# Large tier loads only the toolcall-repair extension; the small/27B tier loads
# none (it dispatches natively). Everything else is identical across tiers.
run_pi() {
  local prompt="$1"
  if [[ "$CODER_TIER" == "large" ]]; then
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
  elif [[ "$CODER_TIER" == "gemma" ]]; then
    # Gemma reasoning coder: no toolcall-repair extension (native structured
    # tool calls), and no --thinking flag (a no-op for this provider — Gemma
    # thinks by its chat-template default; reasoning:true handles parsing).
    pi \
      --no-extensions \
      --no-skills \
      --no-prompt-templates \
      --no-context-files \
      --no-session \
      --tools read,grep,find,ls,write,edit,bash \
      --provider "$PROVIDER" \
      --model "$MODEL" \
      --system-prompt "$(cat "$WORKER_SKILL")" \
      -p "$prompt" 2>&1
  else
    # 27B path: thinking is controllable via PI_CODER_THINKING (scoped to the
    # local-mlx-coder27b provider). Default off (executor). No toolcall ext.
    pi \
      --no-extensions \
      --no-skills \
      --no-prompt-templates \
      --no-context-files \
      --no-session \
      --thinking "$CODER_THINKING" \
      --tools read,grep,find,ls,write,edit,bash \
      --provider "$PROVIDER" \
      --model "$MODEL" \
      --system-prompt "$(cat "$WORKER_SKILL")" \
      -p "$prompt" 2>&1
  fi
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
