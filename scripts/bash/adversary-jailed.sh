#!/usr/bin/env bash
#
# adversary-jailed.sh -- Run a TOOL-ENABLED adversary review inside the
# research-mode read-only jail.
#
# Unlike adversary-pass.sh (which is deterministic single-turn with content
# inlined and NO tools), this lets the adversary navigate the codebase itself
# with read-only tools — but the harness physically prevents it from writing:
#
#   - tools restricted to: read, grep, find, ls, bash-safe, write-research
#   - --research activates the jail (write/edit/raw-bash disabled; bash-safe is
#     an allow-only runner; cp/mv only into the scratch workspace)
#   - only the research-mode extension is loaded (-e), so quorum/adversary-hook
#     do not fire and inflate the turn
#
# The mechanical baseline (scripts/bash/adversary-check.sh) is a SCRIPT, which the
# allow-only jail cannot run, so this wrapper runs it and inlines the result —
# matching the skill's Step 0 contract.
#
# Usage:
#   adversary-jailed.sh <path>            # review a file or directory
#
# NOTE: pi 0.77 fixed the print-mode tool loop that forced adversary-pass.sh to
# be toolless (verified 2026-05-30). The local thinking-adversary model can
# still exhaust its token budget on large inputs — keep targets SMALL for now.
#
# Output: reviews/<label>-<timestamp>.md (prose + fenced adversary-review YAML).
# Always exits 0 (informational, not a gate).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TARGET="${1:?Usage: adversary-jailed.sh <path>}"
if [[ ! -e "$TARGET" ]]; then
  echo "ERROR: target '$TARGET' does not exist." >&2
  exit 1
fi

# --- Model / provider (mirror adversary-pass.sh) ---
if [[ "$(uname -m)" == "arm64" ]]; then
  MODEL="${PI_ADVERSARY_MODEL:-$HOME/models/Qwen3.5-27B-4bit}"
  PROVIDER="local-mlx"
  if ! curl -fs --max-time 3 http://localhost:18080/v1/models >/dev/null 2>&1; then
    echo "ERROR: backend http://localhost:18080 unreachable. Bring it up:" >&2
    echo "         bash <pi-tools>/server/mlx-server.sh up"                 >&2
    exit 2
  fi
else
  MODEL="qwen3-coder:30b"
  PROVIDER="ollama"
fi

# --- Resolve the adversary skill (sole system prompt) ---
SKILL_PATH="${HOME}/.pi/agent/skills/adversary/SKILL.md"
[[ -f "$SKILL_PATH" ]] || SKILL_PATH=".pi/agent/skills/adversary/SKILL.md"
if [[ ! -f "$SKILL_PATH" ]]; then
  echo "ERROR: adversary SKILL.md not found (run install.sh)." >&2
  exit 1
fi

# --- Resolve the research-mode extension (provides the jail) ---
EXT_PATH="${HOME}/.pi/agent/extensions/research-mode.ts"
if [[ ! -f "$EXT_PATH" ]]; then
  echo "ERROR: research-mode.ts not found at $EXT_PATH (run install.sh)." >&2
  exit 1
fi

TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TARGET_LABEL=$(echo "${TARGET#./}" | tr '/' '_' | sed 's/\.[^.]*$//')
REVIEW_DIR="reviews"
REVIEW_FILE="${REVIEW_DIR}/${TARGET_LABEL}-jailed-${TIMESTAMP}.md"
mkdir -p "$REVIEW_DIR"

# --- Step 0 baseline: run the script here; the jailed model cannot ---
# adversary-check.sh sits beside this script in both layouts (repo
# scripts/bash/, installed ~/.pi/agent/scripts/), so resolve it relative to
# this script — not the CWD — then fall back to the global install.
BASELINE="(mechanical baseline unavailable)"
for cand in "$SCRIPT_DIR/adversary-check.sh" "${HOME}/.pi/agent/scripts/adversary-check.sh"; do
  if [[ -f "$cand" ]]; then
    BASELINE=$(bash "$cand" . 2>&1 || true)
    break
  fi
done

read -r -d '' PROMPT <<EOF || true
Review the target below as the adversary. You are in the research-mode jail:
read-only tools + bash-safe only (no writes, no shell, no code/test execution).
Navigate with read/grep/find/ls and bash-safe; do NOT try to run scripts or
tests. Execute protocol Steps 1-11 (Step 0 baseline is provided below). Emit a
prose summary AND the fenced adversary-review YAML block.

Target to review: ${TARGET}

=== Step 0: mechanical baseline (run by the dispatcher) ===
${BASELINE}
EOF

# Jailed, tool-enabled, single research-mode extension only.
REVIEW=$(pi \
  --no-extensions \
  -e "$EXT_PATH" \
  --no-skills \
  --no-prompt-templates \
  --no-context-files \
  --no-session \
  --tools read,grep,find,ls,bash-safe,write-research \
  --research \
  --provider "$PROVIDER" \
  --model "$MODEL" \
  --system-prompt "$(cat "$SKILL_PATH")" \
  -p "$PROMPT" 2>&1) || true

echo "$REVIEW"
echo ""

{
  echo "# Adversary Review (jailed, tool-enabled)"
  echo ""
  echo "**Target**: \`${TARGET}\`"
  echo "**Timestamp**: ${TIMESTAMP}"
  echo "**Model**: ${PROVIDER}/${MODEL}"
  echo "**Mode**: research-mode jail (read,grep,find,ls,bash-safe,write-research)"
  echo ""
  echo "$REVIEW"
} > "$REVIEW_FILE"

echo "Review written to: ${REVIEW_FILE}" >&2
exit 0
