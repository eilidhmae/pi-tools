#!/usr/bin/env bash
#
# adversary-pass.sh -- Run an adversary review on a file or diff.
#
# Usage:
#   adversary-pass.sh <target>           # review a file or diff
#   adversary-pass.sh <target> --revise  # review, then revise if CONCERNS/FAIL
#
# Options:
#   <target>     File path, diff file, or "HEAD" to review working tree changes
#   --revise     If verdict is CONCERNS or FAIL, run a revision pass
#   --model      Model id to use (default: qwen3-coder:30b on ollama)
#   --provider   Provider id from models.json (default: ollama)
#   --adapter    Convenience: shorthand for the adversary adapter on local-mlx.
#                Equivalent to --provider local-mlx --model qwen3-coder-7b+adversary
#   --domain     Convenience: pick a worker adapter by domain
#                (go|rust|python|terraform|general) on local-mlx
#   --quorum     Run quorum manually (3 independent peers, majority wins)
#
# Output:
#   Adversary review written to reviews/<basename>-<timestamp>.md
#   Quorum summary appended if verdict is CONCERNS or FAIL
#
# Note: extensions/quorum.ts handles quorum automatically when pi is running
# interactively. This script provides the same capability for headless/CI use.
#
# Always exits 0 (informational, not a gate).

set -euo pipefail

TARGET="${1:?Usage: adversary-pass.sh <target> [--revise] [--model <model>] [--quorum]}"
REVISE=0
QUORUM=0
MODEL="qwen3-coder:30b"
PROVIDER="ollama"

shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --revise)   REVISE=1 ;;
    --quorum)   QUORUM=1 ;;
    --model)    MODEL="$2"; shift ;;
    --provider) PROVIDER="$2"; shift ;;
    --adapter)  PROVIDER="local-mlx"; MODEL="qwen3-coder-7b+adversary" ;;
    --domain)
      PROVIDER="local-mlx"
      case "$2" in
        go)         MODEL="qwen3-coder-7b+go" ;;
        rust)       MODEL="qwen3-coder-7b+rust" ;;
        python)     MODEL="qwen3-coder-7b+python" ;;
        terraform)  MODEL="qwen3-coder-7b+tf" ;;
        general)    MODEL="qwen3-coder-7b" ;;
        *)          echo "Unknown --domain: $2" >&2; exit 1 ;;
      esac
      shift ;;
    *)          echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
BASENAME=$(basename "$TARGET" | sed 's/\.[^.]*$//')
REVIEW_DIR="reviews"
REVIEW_FILE="${REVIEW_DIR}/${BASENAME}-${TIMESTAMP}.md"
SKILL_PATH="${HOME}/.pi/agent/skills/adversary/SKILL.md"

# Fall back to project-local skill
if [[ ! -f "$SKILL_PATH" ]]; then
  SKILL_PATH=".pi/agent/skills/adversary/SKILL.md"
fi

if [[ ! -f "$SKILL_PATH" ]]; then
  echo "ERROR: adversary SKILL.md not found. Run install.sh first." >&2
  exit 1
fi

mkdir -p "$REVIEW_DIR"

echo "================================================"
echo "  ADVERSARY PASS"
echo "  Target:    $TARGET"
echo "  Model:     ${PROVIDER}/${MODEL}"
echo "  Timestamp: $TIMESTAMP"
echo "================================================"
echo ""

# --- Stage 1: Primary adversary review ---
# Tool flag enforces read-only at harness level (not just by prompt convention)
# --no-extensions prevents the quorum extension from firing recursively
REVIEW=$(cat "$SKILL_PATH" | pi \
  --provider "$PROVIDER" \
  --model "$MODEL" \
  --tools read,grep,ls,bash \
  --no-write \
  --no-edit \
  --no-extensions \
  -p "review @${TARGET}" 2>&1) || true

echo "$REVIEW"
echo ""

# Write review artifact (Enqueue-Before-Ack: write before acting on verdict)
{
  echo "# Adversary Review"
  echo ""
  echo "**Target**: \`${TARGET}\`"
  echo "**Timestamp**: ${TIMESTAMP}"
  echo "**Model**: ${PROVIDER}/${MODEL}"
  echo ""
  echo "$REVIEW"
} > "$REVIEW_FILE"

# --- Extract verdict ---
VERDICT=$(echo "$REVIEW" | grep -E '\*\*VERDICT:' | head -1 | \
  grep -oE 'PASS|CONCERNS|FAIL' | head -1 || echo "UNKNOWN")

echo "Verdict: $VERDICT"
echo "Review written to: $REVIEW_FILE"
echo ""

# --- Stage 2: Quorum (if CONCERNS or FAIL) ---
if [[ "$QUORUM" -eq 1 ]] && [[ "$VERDICT" == "CONCERNS" || "$VERDICT" == "FAIL" ]]; then
  echo "--- Quorum: spawning peer adversaries ---"
  echo ""

  PEER_VERDICTS=("$VERDICT")
  PEER_COUNT=0

  for peer in 1 2; do
    PEER_COUNT=$((PEER_COUNT + 1))
    echo "  Peer ${peer}..."

    PEER_REVIEW=$(cat "$SKILL_PATH" | pi \
      --provider "$PROVIDER" \
      --model "$MODEL" \
      --tools read,grep,ls,bash \
      --no-write \
      --no-edit \
      --no-extensions \
      -p "QUORUM_PEER peer-${peer}: Review @${TARGET}. Return ONLY: VERDICT: [PASS|CONCERNS|FAIL] and top 1-3 findings with file:line." \
      2>&1) || true

    PEER_VERDICT=$(echo "$PEER_REVIEW" | grep -E 'VERDICT:' | head -1 | \
      grep -oE 'PASS|CONCERNS|FAIL' | head -1 || echo "UNKNOWN")

    PEER_VERDICTS+=("$PEER_VERDICT")
    echo "  Peer ${peer} verdict: $PEER_VERDICT"

    # Append peer result to review file
    {
      echo ""
      echo "---"
      echo "## Quorum Peer ${peer}"
      echo ""
      echo "$PEER_REVIEW"
    } >> "$REVIEW_FILE"

    # Early exit: if peer agrees, quorum confirmed — no need for second peer
    if [[ "$PEER_VERDICT" == "CONCERNS" || "$PEER_VERDICT" == "FAIL" ]]; then
      FINAL_VERDICT="$VERDICT"
      echo ""
      echo "Quorum confirmed: self=${VERDICT}, peer${peer}=${PEER_VERDICT} → ${FINAL_VERDICT}"
      break
    fi

    # If first peer disagrees, continue to second peer
    if [[ "$peer" -eq 2 ]]; then
      # Majority of 3
      PASS_COUNT=$(printf '%s\n' "${PEER_VERDICTS[@]}" | grep -c 'PASS' || true)
      if [[ "$PASS_COUNT" -ge 2 ]]; then
        FINAL_VERDICT="CONCERNS"  # downgrade: majority says acceptable
        echo ""
        echo "Quorum: self=${VERDICT}, peer1=${PEER_VERDICTS[1]}, peer2=${PEER_VERDICT} → downgraded to CONCERNS"
      else
        FINAL_VERDICT="$VERDICT"
        echo ""
        echo "Quorum: self=${VERDICT}, peer1=${PEER_VERDICTS[1]:-?}, peer2=${PEER_VERDICT} → ${FINAL_VERDICT} confirmed"
      fi
    fi
  done

  # Update final verdict if quorum changed it
  VERDICT="${FINAL_VERDICT:-$VERDICT}"
  echo "" >> "$REVIEW_FILE"
  echo "**Final Verdict (post-quorum)**: ${VERDICT}" >> "$REVIEW_FILE"
fi

# --- Stage 3: Revision (optional) ---
if [[ "$REVISE" -eq 1 ]] && [[ "$VERDICT" == "CONCERNS" || "$VERDICT" == "FAIL" ]]; then
  echo ""
  echo "--- Revision pass (verdict was ${VERDICT}) ---"
  echo ""

  REVISION_FILE="${REVIEW_DIR}/${BASENAME}-revised-${TIMESTAMP}.go"

  pi \
    --provider "$PROVIDER" \
    --model "$MODEL" \
    -p "Revise @${TARGET} to address all findings in @${REVIEW_FILE}.
Do not add scope. Do not add abstractions not required by the findings.
Follow the TDD mandate: write or update tests first, then fix implementation." \
    2>&1

  echo ""
  echo "Revision complete. Run adversary-pass.sh again to verify."
fi

echo ""
echo "================================================"
echo "  DONE: ${VERDICT}"
echo "================================================"

exit 0
