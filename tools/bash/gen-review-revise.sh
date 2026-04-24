#!/usr/bin/env bash
#
# gen-review-revise.sh -- Generate implementation from spec, adversary review,
#                         optionally revise.
#
# Usage:
#   gen-review-revise.sh <spec.md>              # generate + review
#   gen-review-revise.sh <spec.md> --revise     # generate + review + revise if needed
#   gen-review-revise.sh <spec.md> --model <m>  # override model
#
# Stages:
#   1. Worker: implement from spec (TDD: write tests first)
#   2. Adversary: review the implementation
#   3. Revise: if verdict is CONCERNS/FAIL and --revise, fix and re-review
#
# Output files:
#   drafts/<basename>.go              # implementation
#   drafts/<basename>_test.go         # tests (worker writes these first)
#   reviews/<basename>-<ts>.md        # adversary review
#   reviews/<basename>-revised-<ts>.md  # revision review (if --revise)

set -euo pipefail

SPEC="${1:?Usage: gen-review-revise.sh <spec.md> [--revise] [--model <model>]}"
REVISE=0
MODEL="qwen3-coder:30b"
PROVIDER="ollama"

shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --revise)  REVISE=1 ;;
    --model)   MODEL="$2"; shift ;;
    *)         echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
BASENAME=$(basename "$SPEC" .md)
WORKER_SKILL="${HOME}/.pi/agent/skills/worker/SKILL.md"
ADVERSARY_SKILL="${HOME}/.pi/agent/skills/adversary/SKILL.md"

for path in "$WORKER_SKILL" "$ADVERSARY_SKILL"; do
  if [[ ! -f "$path" ]]; then
    echo "ERROR: skill not found: $path — run install.sh first." >&2
    exit 1
  fi
done

mkdir -p drafts reviews

PI_FLAGS=(
  --provider "$PROVIDER"
  --model "$MODEL"
  --no-extensions
)

# ============================================================
# Stage 1: Worker — implement from spec
# ============================================================
echo ""
echo "=== Stage 1: Worker — implement @${SPEC} ==="
echo ""

cat "$WORKER_SKILL" | pi \
  "${PI_FLAGS[@]}" \
  --tools read,write,edit,bash \
  -p "Implement the spec at @${SPEC}.
TDD mandate: write failing tests first in drafts/${BASENAME}_test.go,
confirm they fail, then implement in drafts/${BASENAME}.go until they pass.
Run the test suite and confirm green before completing.
Report: (1) tests written, (2) tests failing before implementation,
(3) tests passing after implementation." 2>&1

echo ""
echo "Worker done. Reviewing..."

# ============================================================
# Stage 2: Adversary — review the draft
# ============================================================
echo ""
echo "=== Stage 2: Adversary — review drafts/${BASENAME}.go ==="
echo ""

bash "$(dirname "$0")/adversary-pass.sh" \
  "drafts/${BASENAME}.go" \
  --model "$MODEL"

REVIEW_FILE=$(ls -t reviews/${BASENAME}-[0-9]*.md 2>/dev/null | head -1 || true)
VERDICT="UNKNOWN"
if [[ -n "$REVIEW_FILE" ]]; then
  VERDICT=$(grep -E '\*\*VERDICT:' "$REVIEW_FILE" | head -1 | \
    grep -oE 'PASS|CONCERNS|FAIL' | head -1 || echo "UNKNOWN")
fi

echo ""
echo "Adversary verdict: $VERDICT"

# ============================================================
# Stage 3: Revise (optional)
# ============================================================
if [[ "$REVISE" -eq 1 ]] && [[ "$VERDICT" == "CONCERNS" || "$VERDICT" == "FAIL" ]]; then
  echo ""
  echo "=== Stage 3: Revision — addressing adversary findings ==="
  echo ""

  cat "$WORKER_SKILL" | pi \
    "${PI_FLAGS[@]}" \
    --tools read,write,edit,bash \
    -p "Revise drafts/${BASENAME}.go to address all findings in @${REVIEW_FILE}.
Do not add scope beyond what the findings require.
Follow TDD: update tests if needed, then fix implementation.
Run the full test suite and confirm green before completing." 2>&1

  echo ""
  echo "=== Stage 3b: Re-review after revision ==="
  echo ""

  bash "$(dirname "$0")/adversary-pass.sh" \
    "drafts/${BASENAME}.go" \
    --model "$MODEL"

  FINAL_REVIEW=$(ls -t reviews/${BASENAME}-[0-9]*.md 2>/dev/null | head -1 || true)
  FINAL_VERDICT="UNKNOWN"
  if [[ -n "$FINAL_REVIEW" ]]; then
    FINAL_VERDICT=$(grep -E '\*\*VERDICT:' "$FINAL_REVIEW" | head -1 | \
      grep -oE 'PASS|CONCERNS|FAIL' | head -1 || echo "UNKNOWN")
  fi

  echo ""
  echo "Final verdict after revision: $FINAL_VERDICT"
  VERDICT="$FINAL_VERDICT"
fi

echo ""
echo "================================================"
echo "  COMPLETE: ${VERDICT}"
echo "  Implementation: drafts/${BASENAME}.go"
echo "  Reviews:        reviews/"
echo "================================================"

exit 0
