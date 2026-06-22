#!/usr/bin/env bash
#
# coder-review.sh -- One-shot IMPLEMENTABILITY review of a plan by the CODER
# model (the party that will build it). The RPI plan gate runs this alongside
# the adversary as a heterogeneous, serial-INDEPENDENT pair.
#
# This is the read-only sibling of coder-run.sh: same tier selection (the coder
# backend), but NO tools and NO writes to the repo — it is a single-turn review,
# exactly like adversary-pass.sh, with the plan inlined into the prompt. The plan
# is small, so single-turn does not run away: the <think>-budget runaway only
# bites real-sized inputs, and a plan is small — the small payload is the real
# guard. Thinking-off is a SECONDARY control: it takes effect on the 27B path via
# the local-mlx-coder27b provider's qwen-chat-template compat (the same scoped
# toggle coder-run.sh uses; the 27B backend honours enable_thinking=false —
# verified). pi's plain --thinking flag is a no-op on the un-compat'd local-mlx
# provider, so do NOT rely on the flag alone — rely on the small payload.
#
# Usage:
#   coder-review.sh <plan-file>                       # review a plan file
#   coder-review.sh <plan-file> --goal "<text>"       # add the goal as context
#   coder-review.sh <plan-file> --model M --provider P  # override the backend
#
# Tier (PI_CODER_TIER, mirrors coder-run.sh; the reviewer should be the model
# that will implement):
#   large (default): the 32B dense coder on :18111 (local-mlx-coder32b).
#   small:           the 27B on :18080 (local-mlx-coder27b, thinking-off) for
#                    <112GB boxes where the 32B can't co-reside.
#   gemma:           the Gemma-4-31B reasoning coder on :18112
#                    (local-mlx-gemma431b); thinking on by model default.
# --model/--provider override the tier (e.g. point at a parked 30B-A3B once its
# backend is up for a depth pass).
#
# Output:
#   Review written to reviews/<plan>-coder-review-<timestamp>.md
#   The prose summary and the fenced `coder-review` YAML block land in the file.
#   This is a SEPARATE label from `adversary-review`: the coder review is NOT
#   captured into the adversary-general training corpus (different role/model).
#
# Always exits 0 (informational, not a gate). Backend/arg failures exit non-zero.

set -euo pipefail

PLAN="${1:?Usage: coder-review.sh <plan-file> [--goal \"<text>\"] [--model M] [--provider P]}"
shift

GOAL=""
MODEL=""
PROVIDER=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --goal)     GOAL="${2:?--goal needs text}"; shift ;;
    --model)    MODEL="${2:?--model needs an id}"; shift ;;
    --provider) PROVIDER="${2:?--provider needs an id}"; shift ;;
    *)          echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

if [[ ! -f "$PLAN" ]]; then
  echo "ERROR: plan file not found: $PLAN" >&2
  exit 1
fi

# --- Tier select (Apple-Silicon arm64, or aarch64 container guest → host MLX) ---
if [[ "$(uname -m)" != "arm64" && "$(uname -m)" != "aarch64" ]]; then
  echo "ERROR: coder-review.sh requires Apple Silicon (arm64) or a Linux/aarch64" >&2
  echo "       container-harness guest forwarding to the host MLX backends." >&2
  exit 2
fi
CODER_TIER="${PI_CODER_TIER:-large}"
CODER_THINKING="${PI_CODER_THINKING:-off}"   # 27B path; effective only via the coder27b qwen-chat-template compat (see header). The small plan payload is the real runaway guard, not this flag.

# Resolve provider/model/port from the tier unless explicitly overridden.
if [[ -z "$PROVIDER" || -z "$MODEL" ]]; then
  case "$CODER_TIER" in
    large)
      PROVIDER="${PROVIDER:-local-mlx-coder32b}"
      MODEL="${MODEL:-mlx-community/Qwen2.5-Coder-32B-Instruct-8bit}"
      CODER_PORT=18111
      ;;
    small)
      PROVIDER="${PROVIDER:-local-mlx-coder27b}"
      MODEL="${MODEL:-${HOME}/models/Qwen3.5-27B-4bit}"
      CODER_PORT=18080
      ;;
    gemma)
      PROVIDER="${PROVIDER:-local-mlx-gemma431b}"
      MODEL="${MODEL:-unsloth/gemma-4-31b-it-MLX-8bit}"
      CODER_PORT=18112
      ;;
    *)
      echo "ERROR: PI_CODER_TIER must be 'large', 'small', or 'gemma' (got '${CODER_TIER}')." >&2
      exit 2
      ;;
  esac
else
  # Both overridden: derive the port from the provider's known band, else trust
  # the override and skip the reachability precheck (operator's responsibility).
  case "$PROVIDER" in
    local-mlx-coder32b) CODER_PORT=18111 ;;
    local-mlx-gemma431b) CODER_PORT=18112 ;;
    local-mlx-coder27b|local-mlx) CODER_PORT=18080 ;;
    *) CODER_PORT="" ;;
  esac
fi

if [[ -n "${CODER_PORT}" ]] && ! curl -fs --max-time 3 "http://localhost:${CODER_PORT}/v1/models" >/dev/null 2>&1; then
  echo "ERROR: backend http://localhost:${CODER_PORT} unreachable. Bring it up:" >&2
  echo "         bash <pi-tools>/server/mlx-server.sh up"                         >&2
  echo "       On <112GB boxes the 32B (:18111) is absent — set PI_CODER_TIER=small." >&2
  exit 2
fi

# --- Resolve coder-review SKILL.md (sole system prompt) ---
SKILL_PATH="${HOME}/.pi/agent/skills/coder-review/SKILL.md"
[[ -f "$SKILL_PATH" ]] || SKILL_PATH=".pi/agent/skills/coder-review/SKILL.md"
[[ -f "$SKILL_PATH" ]] || SKILL_PATH="skills/coder-review/SKILL.md"
if [[ ! -f "$SKILL_PATH" ]]; then
  echo "ERROR: coder-review SKILL.md not found (run install.sh)." >&2
  exit 1
fi

TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
PLAN_LABEL=$(echo "${PLAN#./}" | tr '/' '_' | sed 's/\.[^.]*$//')
REVIEW_DIR="reviews"
REVIEW_FILE="${REVIEW_DIR}/${PLAN_LABEL}-coder-review-${TIMESTAMP}.md"
mkdir -p "$REVIEW_DIR"

PLAN_SHA=$(shasum -a 256 "$PLAN" | awk '{print substr($1, 1, 16)}')
PLAN_LINES=$(wc -l < "$PLAN" | tr -d ' ')

# --- Build the inlined payload ---
PAYLOAD=$(mktemp -t coder-review-payload)
trap 'rm -f "$PAYLOAD"' EXIT
{
  echo "Review the following implementation PLAN as the implementor who will"
  echo "build it. Inline content only; you have no tools. Judge implementability"
  echo "and approach; flag blockers and unverifiable facts; do NOT judge whether"
  echo "the artifact should exist (that is the adversary's call). Emit a prose"
  echo "summary AND the fenced coder-review YAML block."
  echo
  echo "Set these artifact fields verbatim in the YAML block:"
  echo "  path: ${PLAN}"
  echo "  lines_reviewed: 1-${PLAN_LINES}   (sha256 ${PLAN_SHA})"
  echo
  if [[ -n "$GOAL" ]]; then
    echo "=== GOAL ==="
    echo "$GOAL"
    echo
  fi
  echo "=== PLAN: ${PLAN} ==="
  cat "$PLAN"
  echo "=== END PLAN ==="
} > "$PAYLOAD"

echo "================================================"
echo "  CODER REVIEW (implementability)"
echo "  Plan:      $PLAN"
echo "  Model:     ${PROVIDER}/${MODEL}  (tier ${CODER_TIER})"
echo "  Timestamp: $TIMESTAMP"
echo "  Payload:   $(wc -l < "$PAYLOAD") lines, $(wc -c < "$PAYLOAD") bytes"
echo "================================================"
echo ""

# --- Single-turn pi: every autoload off, skill as the SOLE system prompt ---
# Same rationale as adversary-pass.sh: --system-prompt replaces pi's stock
# coding-assistant preamble (which otherwise frames this as a multi-turn agent
# task and, on a thinking model, can eat the whole token budget). No tools: the
# plan is inlined, the model only emits the review. The 27B path passes
# --thinking, which only bites via the coder27b qwen-chat-template compat (the
# small payload is the real runaway guard; see header).
run_pi() {
  if [[ "$CODER_TIER" == "small" || "$PROVIDER" == "local-mlx-coder27b" ]]; then
    pi \
      --no-extensions --no-tools --no-skills --no-prompt-templates \
      --no-context-files --no-session \
      --thinking "$CODER_THINKING" \
      --provider "$PROVIDER" --model "$MODEL" \
      --system-prompt "$(cat "$SKILL_PATH")" \
      -p "$(cat "$PAYLOAD")" 2>&1
  else
    pi \
      --no-extensions --no-tools --no-skills --no-prompt-templates \
      --no-context-files --no-session \
      --provider "$PROVIDER" --model "$MODEL" \
      --system-prompt "$(cat "$SKILL_PATH")" \
      -p "$(cat "$PAYLOAD")" 2>&1
  fi
}

REVIEW=$(run_pi) || true
echo "$REVIEW"
echo ""

# Persist the review (Enqueue-Before-Ack: write before reporting).
{
  echo "# Coder Review (implementability)"
  echo ""
  echo "**Plan**: \`${PLAN}\`"
  echo "**Timestamp**: ${TIMESTAMP}"
  echo "**Model**: ${PROVIDER}/${MODEL} (tier ${CODER_TIER})"
  echo ""
  echo "$REVIEW"
} > "$REVIEW_FILE"

# --- Extract verdict (YAML `verdict:` authoritative, prose fallback) ---
VERDICT=$(echo "$REVIEW" | grep -E '^verdict:[[:space:]]*(PASS|CONCERNS|FAIL)\b' \
            | head -1 | grep -oE 'PASS|CONCERNS|FAIL' | head -1 || true)
if [[ -z "$VERDICT" ]]; then
  VERDICT=$(echo "$REVIEW" | grep -E '\*\*VERDICT:|\*\*PASS\*\*|\*\*CONCERNS\*\*|\*\*FAIL\*\*' \
              | head -1 | grep -oE 'PASS|CONCERNS|FAIL' | head -1 || true)
fi
[[ -z "$VERDICT" ]] && VERDICT="UNKNOWN"

echo "Verdict: $VERDICT"
echo "Model: $MODEL"
echo "Review written to: $REVIEW_FILE"
echo ""
echo "================================================"
echo "  DONE: ${VERDICT}"
echo "================================================"
exit 0
