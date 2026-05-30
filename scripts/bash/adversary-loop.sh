#!/usr/bin/env bash
#
# adversary-loop.sh -- Bounded multi-pass adversary review (PROTOTYPE).
#
# Externalises "thinking" into the harness: instead of relying on the
# model's internal <think> reasoning (flaky on a coder base, and the
# server-side think-state machine is a known foot-gun), this runs the
# deterministic single-turn adversary repeatedly, feeding each pass the
# prior pass's findings and asking it to confirm / retract / extend.
# The reasoning trace becomes a visible sequence of reviews on disk,
# not ephemeral in-context tokens.
#
# This is the automation of a step adversary-pass.sh already documents
# manually: its --revise path ends by printing "Re-run adversary-pass.sh
# to verify." The loop performs that re-run-to-verify automatically and
# stops when the verdict stabilises.
#
# Usage:
#   adversary-loop.sh <target> [--max N] [-- <adversary-pass.sh flags>]
#
# Targets: same as adversary-pass.sh (<path> | HEAD | STAGED | RANGE:A..B).
#
# Options:
#   --max N   Hard iteration cap. Default 3 -- matches the "max 3
#             reviewers, then human judgement" convergence cap in the
#             manager role spec. If the verdict has not stabilised by
#             N passes, the loop stops and flags it for human review
#             rather than spinning.
#   --        Everything after is passed through verbatim to
#             adversary-pass.sh (e.g. --domain go, --adapter, --model).
#
# Convergence (stops at the first of):
#   * iteration 1 returns PASS        -> nothing to iterate on
#   * verdict identical 2 passes running
#   * --max reached                   -> escalate to human
#
# Corpus discipline:
#   adversary-pass.sh auto-captures every run into bootstrap.jsonl.
#   Intermediate (pre-convergence) reviews are low quality and would
#   dilute the training corpus, so this driver runs every pass with
#   ADV_NO_CAPTURE=1 and captures ONLY the converged review, once,
#   via capture-review.sh at the end.
#
# Bug-class note (<think> re-trigger): the model's review prose may
# quote literal "<think>" tokens (it often reviews code that mentions
# them). Feeding that back unchanged risks the server's think-state
# scan flipping the next pass into reasoning mode -> empty content.
# Two guards: (1) sanitise <think>/</think> out of fed-back text;
# (2) append a fixed instruction footer so fed-back text can never
# occupy the prompt tail window the scan inspects.
#
# Always exits 0 (informational, not a gate) -- same contract as
# adversary-pass.sh.

set -euo pipefail

TARGET="${1:?Usage: adversary-loop.sh <target|HEAD|STAGED|RANGE:A..B> [--max N] [-- <pass-through flags>]}"
shift

MAX=3
PASSTHRU=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --max) MAX="$2"; shift 2 ;;
    --)    shift; PASSTHRU=("$@"); break ;;
    *)     echo "Unknown option: $1 (did you mean to put it after '--'?)" >&2; exit 1 ;;
  esac
done

# Resolve the adversary-pass.sh driver (sibling install or global).
PASS_SH=""
for c in "$(dirname "${BASH_SOURCE[0]}")/adversary-pass.sh" \
         "$HOME/.pi/agent/scripts/adversary-pass.sh"; do
  if [[ -x "$c" ]]; then PASS_SH="$c"; break; fi
done
[[ -n "$PASS_SH" ]] || { echo "ERROR: adversary-pass.sh not found." >&2; exit 1; }

CAPTURE_SH=""
for c in "$(dirname "${BASH_SOURCE[0]}")/capture-review.sh" \
         "$HOME/.pi/agent/scripts/capture-review.sh"; do
  if [[ -x "$c" ]]; then CAPTURE_SH="$c"; break; fi
done

# --- Resolve the target into a stable base payload (once) ---
# File targets: inline the file. Diff targets: snapshot the diff now so
# every iteration reviews the same artifact (the working tree may change
# under us otherwise).
BASE=$(mktemp -t adv-loop-base)
PACKET=$(mktemp -t adv-loop-packet)
trap 'rm -f "$BASE" "$PACKET"' EXIT

case "$TARGET" in
  HEAD)        git diff HEAD        > "$BASE" ;;
  STAGED)      git diff --cached    > "$BASE" ;;
  RANGE:*)     git diff "${TARGET#RANGE:}" > "$BASE" ;;
  *)
    [[ -f "$TARGET" ]] || { echo "ERROR: no such file: $TARGET" >&2; exit 1; }
    cat "$TARGET" > "$BASE" ;;
esac
[[ -s "$BASE" ]] || { echo "ERROR: empty review target ($TARGET)." >&2; exit 1; }

# strip <think>/</think> from fed-back text (see header bug-class note)
sanitise() { sed 's/<think>/[think]/g; s#</think>#[/think]#g'; }

extract_verdict() {
  # adversary-pass.sh prints "Verdict: X" and a "DONE: X" banner.
  grep -E '^Verdict:' | tail -1 | sed -E 's/^Verdict:[[:space:]]*//'
}
extract_model() {
  # adversary-pass.sh prints "Model: X" (the model AFTER its own
  # --model/--adapter/--domain resolution). We attribute the capture to
  # that, not a guessed default -- otherwise --adapter/--domain runs are
  # mislabelled.
  grep -E '^Model:' | tail -1 | sed -E 's/^Model:[[:space:]]*//'
}

REVIEW_DIR="reviews"
mkdir -p "$REVIEW_DIR"
LOOP_STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
LOG="${REVIEW_DIR}/loop-${LOOP_STAMP}.md"
{
  echo "# adversary-loop: ${TARGET}"
  echo "_started ${LOOP_STAMP}, max ${MAX} passes_"
  echo
} > "$LOG"

PREV_VERDICT=""
PREV_REVIEW=""
VERDICT="UNKNOWN"
CONVERGED=0
i=0
while (( i < MAX )); do
  i=$((i+1))
  echo "=================================================="
  echo "  adversary-loop pass ${i}/${MAX}  (target: ${TARGET})"
  echo "=================================================="

  # Build this pass's packet: base artifact + (prior findings) + footer.
  {
    cat "$BASE"
    if [[ -n "$PREV_REVIEW" ]]; then
      echo
      echo "=== PRIOR ADVERSARY FINDINGS (pass $((i-1))) ==="
      printf '%s\n' "$PREV_REVIEW" | sanitise
      echo "=== END PRIOR FINDINGS ==="
    fi
    echo
    echo "This is verification pass ${i} of a bounded loop (max ${MAX})."
    echo "Re-examine the artifact above. Confirm each prior finding that"
    echo "still holds, retract any that were wrong or out of scope, and add"
    echo "anything missed. Do NOT invent issues to justify another pass."
    echo "Emit the prose summary AND the fenced adversary-review YAML block,"
    echo "ending with the verdict line."
  } > "$PACKET"

  # Every pass suppresses capture; we capture the converged one ourselves.
  # ${arr[@]+...} guard: empty-array expansion under `set -u` errors on
  # macOS bash 3.2 ("unbound variable"). The guard makes it expand to
  # nothing when PASSTHRU is empty.
  OUT=$(ADV_NO_CAPTURE=1 "$PASS_SH" "$PACKET" ${PASSTHRU[@]+"${PASSTHRU[@]}"} 2>&1) || true
  echo "$OUT"

  VERDICT=$(printf '%s\n' "$OUT" | extract_verdict)
  [[ -n "$VERDICT" ]] || VERDICT="UNKNOWN"
  LOOP_MODEL=$(printf '%s\n' "$OUT" | extract_model)
  PREV_REVIEW="$OUT"

  {
    echo "## Pass ${i}: ${VERDICT}"
    echo
  } >> "$LOG"

  # Convergence checks.
  if (( i == 1 )) && [[ "$VERDICT" == "PASS" ]]; then
    echo "Converged: PASS on first pass -- no iteration needed."
    CONVERGED=1; break
  fi
  if [[ -n "$PREV_VERDICT" && "$VERDICT" == "$PREV_VERDICT" ]]; then
    echo "Converged: verdict '${VERDICT}' stable across passes $((i-1))-${i}."
    CONVERGED=1; break
  fi
  PREV_VERDICT="$VERDICT"
done

# --- Capture the converged review only ---
# Skip an UNKNOWN verdict: it means no parseable verdict came back (dead
# server, killed pass, empty output) -- a degenerate record that would
# poison the training corpus rather than seed it.
FINAL_REVIEW="${REVIEW_DIR}/loop-final-${LOOP_STAMP}.md"
printf '%s\n' "$PREV_REVIEW" > "$FINAL_REVIEW"
if [[ -n "${ADV_NO_CAPTURE:-}" ]]; then
  echo "capture: skipped (ADV_NO_CAPTURE set for the whole loop)"
elif [[ "$VERDICT" == "UNKNOWN" || -z "$VERDICT" ]]; then
  echo "capture: skipped (verdict UNKNOWN -- not seeding corpus with a degenerate record)"
elif [[ -n "$CAPTURE_SH" ]]; then
  CAPTURE_ARGS=(--review "$FINAL_REVIEW" --scope "$TARGET" --temperature 0)
  # Attribute to the model adversary-pass.sh actually resolved/ran
  # (handles --model/--adapter/--domain), not a guessed default.
  [[ -n "${LOOP_MODEL:-}" ]] && CAPTURE_ARGS+=(--model "$LOOP_MODEL")
  [[ -f "$TARGET" ]] && CAPTURE_ARGS+=(--artifact-path "$TARGET")
  git rev-parse HEAD &>/dev/null && CAPTURE_ARGS+=(--git-sha "$(git rev-parse HEAD)")
  "$CAPTURE_SH" "${CAPTURE_ARGS[@]}" 2>&1 || echo "capture: helper failed (non-fatal)"
fi

# F3: adversary-pass.sh writes a per-pass review .md named after our
# packet tmpfile. Those are redundant (the loop keeps loop-*.md and
# loop-final-*.md) and clutter reviews/. Remove the packet-derived ones.
rm -f "${REVIEW_DIR}/"*adv-loop-packet*.md 2>/dev/null || true

{
  echo "---"
  if (( CONVERGED == 1 )); then
    echo "**Converged** after ${i} pass(es). Final verdict: **${VERDICT}**."
  else
    echo "**NOT converged** -- hit --max ${MAX} without a stable verdict."
    echo "Final verdict: **${VERDICT}**. Escalate to human judgement"
    echo "(per the bounded-reviewer cap)."
  fi
} >> "$LOG"

echo ""
echo "================================================"
if (( CONVERGED == 1 )); then
  echo "  LOOP DONE (converged, ${i} pass): ${VERDICT}"
else
  echo "  LOOP DONE (NO CONVERGENCE @ max ${MAX}): ${VERDICT} -- escalate"
fi
echo "  trace: ${LOG}"
echo "================================================"

exit 0
