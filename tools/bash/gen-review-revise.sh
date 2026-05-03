#!/usr/bin/env bash
#
# gen-review-revise.sh -- Generate implementation from spec, adversary review,
#                         optionally revise.
#
# Usage:
#   gen-review-revise.sh <spec.md>                       # generate + review
#   gen-review-revise.sh <spec.md> --revise              # generate + review + revise if needed
#   gen-review-revise.sh <spec.md> --model <m>           # override worker model
#   gen-review-revise.sh <spec.md> --provider <p>        # override worker provider
#   gen-review-revise.sh <spec.md> --domain <go|rust|python|terraform|general>
#                                                        # convenience: pick a worker adapter on local-mlx
#
# Adversary stage selection (operator-opt-in):
#   default            adversary inherits the worker's --provider/--model
#                      (works on Ollama-only deployments)
#   --adversary-adapter call adversary-pass.sh --adapter, which uses
#                      qwen3-coder-7b+adversary on local-mlx. Requires
#                      the +adversary adapter to be installed.
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
ADVERSARY_ADAPTER=0

shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --revise)              REVISE=1 ;;
    --model)               MODEL="$2"; shift ;;
    --provider)            PROVIDER="$2"; shift ;;
    --adversary-adapter)   ADVERSARY_ADAPTER=1 ;;
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

# Build the adversary invocation flags once. Default: inherit the
# worker's provider/model (Ollama-friendly). Opt-in: --adapter, which
# adversary-pass.sh maps to local-mlx + qwen3-coder-7b+adversary.
if [[ "$ADVERSARY_ADAPTER" -eq 1 ]]; then
  ADVERSARY_FLAGS=( --adapter )
else
  ADVERSARY_FLAGS=( --provider "$PROVIDER" --model "$MODEL" )
fi

TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
BASENAME=$(basename "$SPEC" .md)
# Skill discovery: prefer global install, fall back to project-local
# (matches adversary-pass.sh). Error message names both candidates so the
# operator can see which install they actually need.
declare -A SKILL_GLOBAL=(
  [worker]="${HOME}/.pi/agent/skills/worker/SKILL.md"
  [adversary]="${HOME}/.pi/agent/skills/adversary/SKILL.md"
)
declare -A SKILL_LOCAL=(
  [worker]=".pi/agent/skills/worker/SKILL.md"
  [adversary]=".pi/agent/skills/adversary/SKILL.md"
)

resolve_skill() {
  # Called via $(resolve_skill kind) so failure exits the subshell with 1;
  # set -e on the outer script then aborts. stderr from the diagnostic
  # below is propagated to the operator's terminal in normal usage; if a
  # caller redirects this script's stderr (e.g. 2>/dev/null), the
  # diagnostic is silently dropped — but the script still exits non-zero.
  local kind="$1"
  if   [[ -f "${SKILL_GLOBAL[$kind]}" ]]; then echo "${SKILL_GLOBAL[$kind]}"
  elif [[ -f "${SKILL_LOCAL[$kind]}"  ]]; then echo "${SKILL_LOCAL[$kind]}"
  else
    echo "ERROR: $kind SKILL.md not found. Checked:" >&2
    echo "  ${SKILL_GLOBAL[$kind]}" >&2
    echo "  ${SKILL_LOCAL[$kind]}  (relative to CWD: $(pwd))" >&2
    echo "Run install.sh first." >&2
    exit 1
  fi
}
WORKER_SKILL="$(resolve_skill worker)"
ADVERSARY_SKILL="$(resolve_skill adversary)"

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
  "${ADVERSARY_FLAGS[@]}"

# Verdict extraction: prefer YAML `verdict:` (authoritative per
# skills/adversary/SKILL.md), fall back to prose `**VERDICT:**`.
# `||` chaining is unreliable here because `head -1` always exits 0;
# explicit empty-checks below.
extract_verdict() {
  local file="$1" v
  v=$(grep -E '^verdict:[[:space:]]*(PASS|CONCERNS|FAIL)\b' "$file" 2>/dev/null \
        | head -1 | grep -oE 'PASS|CONCERNS|FAIL' | head -1)
  if [[ -z "$v" ]]; then
    v=$(grep -E '\*\*VERDICT:' "$file" 2>/dev/null \
          | head -1 | grep -oE 'PASS|CONCERNS|FAIL' | head -1)
  fi
  [[ -z "$v" ]] && v="UNKNOWN"
  echo "$v"
}

REVIEW_FILE=$(ls -t reviews/${BASENAME}-[0-9]*.md 2>/dev/null | head -1 || true)
VERDICT="UNKNOWN"
if [[ -n "$REVIEW_FILE" ]]; then
  VERDICT="$(extract_verdict "$REVIEW_FILE")"
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
    "${ADVERSARY_FLAGS[@]}"

  FINAL_REVIEW=$(ls -t reviews/${BASENAME}-[0-9]*.md 2>/dev/null | head -1 || true)
  FINAL_VERDICT="UNKNOWN"
  if [[ -n "$FINAL_REVIEW" ]]; then
    FINAL_VERDICT="$(extract_verdict "$FINAL_REVIEW")"
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
