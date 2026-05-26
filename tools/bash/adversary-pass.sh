#!/usr/bin/env bash
#
# adversary-pass.sh -- Run an adversary review on a file or diff.
#
# Usage:
#   adversary-pass.sh <target>           # review a file, HEAD, STAGED, or RANGE:A..B
#   adversary-pass.sh <target> --quorum  # also run 2 peer reviewers
#
# Targets:
#   <path>      Path to a single source file. Contents are inlined into
#               the prompt; no file-system tools are needed by the model.
#   HEAD        Review `git diff HEAD` (working-tree changes).
#   STAGED      Review `git diff --cached` (pre-commit semantics).
#   RANGE:A..B  Review `git diff A..B` (e.g. pre-push hooks: origin..HEAD).
#
# Options:
#   --revise     If verdict is CONCERNS/FAIL, run a revision pass.
#                NOTE: revise needs file-system tools, which require the
#                interactive pi mode that this script intentionally avoids.
#                The revise pass is a best-effort passthrough and may not
#                work headless in pi 0.74.0; see OPERATIONS.md.
#   --model      Model id. Default is auto-detected: on Apple Silicon,
#                "qwen3-coder-30b-a3b" via local-mlx. The MLX stack must
#                be reachable on localhost:18080 -- if it isn't, the
#                script aborts (there is no ollama fallback on arm64;
#                bring the stack up with server/mlx-server.sh up). On
#                non-Apple platforms, "qwen3-coder:30b" via ollama
#                (legacy path).
#   --provider   Provider id from models.json. Default auto-detected
#                alongside --model (see above).
#   --adapter    Shorthand: --provider local-mlx --model qwen3-coder-30b-a3b+adversary.
#   --domain     Shorthand: pick worker adapter by domain
#                (go|rust|python|terraform|general) on local-mlx.
#   --quorum     Run 2 additional peer reviewers; majority decides.
#
# Output:
#   Adversary review written to reviews/<basename>-<timestamp>.md
#   Both the prose summary and the fenced `adversary-review` YAML block
#   land in the file. Quorum peer reviews appended if --quorum and the
#   primary verdict is CONCERNS/FAIL.
#
# Why deterministic single-turn:
#   pi 0.74.0 -p (print mode) with autoloaded tools/skills/extensions
#   silently enters a multi-turn loop that exits with empty stdout.
#   This script invokes pi with all autoloads OFF and supplies the skill
#   via --append-system-prompt; the target's content (file or diff) is
#   inlined into the user prompt because the model has no tool access.
#   See operator notes from 2026-05-14 for why (decision lives outside
#   this repo; the short version is "autoloaded tools confuse pi -p").
#
# Always exits 0 (informational, not a gate).

set -euo pipefail

TARGET="${1:?Usage: adversary-pass.sh <target|HEAD|STAGED> [--quorum] [--revise]}"
REVISE=0
QUORUM=0

# --- Auto-detect default provider/model ---
# On Apple Silicon the default is local-mlx + qwen3-coder-30b-a3b (the
# MLX stack this repo brings up). If localhost:18080 is unreachable we
# fail LOUDLY rather than silently falling back to a different backend:
# corpus contamination from a fallback model -- different weights →
# different verdicts, silently mislabelled -- is worse than a noisy
# abort. The ollama fallback was removed on 2026-05-16 after a salvage
# batch quietly emitted records labelled ollama/qwen3-coder:30b when the
# local-mlx probe transiently failed. ollama has no role on Apple
# Silicon anyway: it serves the same base model via a different runtime
# and can't load the per-role LoRA adapters this harness is built on.
# On non-Apple platforms the legacy ollama path still applies.
# --provider / --model / --adapter / --domain flags override this.
if [[ "$(uname -m)" == "arm64" ]]; then
  MODEL="qwen3-coder-30b-a3b"
  PROVIDER="local-mlx"
  if ! curl -fs --max-time 3 http://localhost:18080/v1/models >/dev/null 2>&1; then
    echo "ERROR: default backend http://localhost:18080 unreachable on"  >&2
    echo "       Apple Silicon. Bring it up with:"                        >&2
    echo "         bash <pi-tools>/server/mlx-server.sh up"               >&2
    echo "       Or pass an explicit --provider / --model to bypass."     >&2
    echo "       (No ollama fallback on arm64: same model, different"     >&2
    echo "       runtime, can't load adapters, and contaminates the"      >&2
    echo "       corpus -- removed 2026-05-16.)"                          >&2
    exit 2
  fi
else
  MODEL="qwen3-coder:30b"
  PROVIDER="ollama"
fi

shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --revise)   REVISE=1 ;;
    --quorum)   QUORUM=1 ;;
    --model)    MODEL="$2"; shift ;;
    --provider) PROVIDER="$2"; shift ;;
    --adapter)  PROVIDER="local-mlx"; MODEL="qwen3-coder-30b-a3b+adversary" ;;
    --domain)
      PROVIDER="local-mlx"
      case "$2" in
        go)         MODEL="qwen3-coder-30b-a3b+go" ;;
        rust)       MODEL="qwen3-coder-30b-a3b+rust" ;;
        python)     MODEL="qwen3-coder-30b-a3b+python" ;;
        terraform)  MODEL="qwen3-coder-30b-a3b+tf" ;;
        general)    MODEL="qwen3-coder-30b-a3b" ;;
        *)          echo "Unknown --domain: $2" >&2; exit 1 ;;
      esac
      shift ;;
    *)          echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# Strip a leading `./` before substituting separators so `./foo/bar.go`
# becomes label `foo_bar`, not `._foo_bar`. The latter looks like a
# macOS AppleDouble resource-fork file (`._<name>`), which some tooling
# (tar archives, web servers) filters or treats specially. HEAD / STAGED /
# RANGE:* targets start with capital letters so the strip is a no-op.
TARGET_LABEL=$(echo "${TARGET#./}" | tr '/' '_' | sed 's/\.[^.]*$//')
REVIEW_DIR="reviews"
REVIEW_FILE="${REVIEW_DIR}/${TARGET_LABEL}-${TIMESTAMP}.md"

# --- Resolve adversary SKILL.md ---
SKILL_GLOBAL="${HOME}/.pi/agent/skills/adversary/SKILL.md"
SKILL_LOCAL=".pi/agent/skills/adversary/SKILL.md"
SKILL_PATH="$SKILL_GLOBAL"
[[ -f "$SKILL_PATH" ]] || SKILL_PATH="$SKILL_LOCAL"

if [[ ! -f "$SKILL_PATH" ]]; then
  echo "ERROR: adversary SKILL.md not found. Checked:" >&2
  echo "  $SKILL_GLOBAL" >&2
  echo "  $SKILL_LOCAL  (relative to CWD: $(pwd))" >&2
  echo "Run install.sh first." >&2
  exit 1
fi

mkdir -p "$REVIEW_DIR"

# --- Build the inlined context payload ---
# The model has no file-system tools (deterministic single-turn pi),
# so this script must supply everything the adversary needs in the
# prompt itself. Steps 0-2 of the SKILL protocol (mechanical baseline,
# claim verification, test verification) are skipped — they require
# tool access. Steps 3-11 (Operational Robustness, Complexity, Scope,
# Alternatives, Assumptions, Security, Integer/Bounds, Verdict) execute
# on the inlined content.
PAYLOAD=$(mktemp -t adv-payload)
trap 'rm -f "$PAYLOAD"' EXIT

case "$TARGET" in
  HEAD)
    if ! git rev-parse --is-inside-work-tree &>/dev/null; then
      echo "ERROR: HEAD target requires a git repository (CWD: $(pwd))" >&2
      exit 1
    fi
    if [[ -z "$(git diff HEAD)" ]]; then
      echo "ERROR: working tree clean — nothing to review against HEAD." >&2
      echo "       Provide a file path, edit something, or use STAGED." >&2
      exit 1
    fi
    {
      echo "Review the following working-tree diff. Inline content only;"
      echo "you have no file-system tools. Skip protocol Steps 0-2"
      echo "(mechanical baseline, claim verification, test verification)."
      echo "Execute Steps 3-11. Emit prose summary AND the fenced"
      echo "adversary-review YAML block."
      echo
      echo "Set these artifact fields verbatim in the YAML block:"
      echo "  path: HEAD"
      echo "  lines_reviewed: all"
      echo "Leave artifact.sha256 unset (no single artifact to hash)."
      echo
      echo "=== git diff --stat HEAD ==="
      git diff --stat HEAD
      echo
      echo "=== git diff HEAD ==="
      git diff HEAD
    } > "$PAYLOAD"
    ;;
  STAGED)
    if ! git rev-parse --is-inside-work-tree &>/dev/null; then
      echo "ERROR: STAGED target requires a git repository (CWD: $(pwd))" >&2
      exit 1
    fi
    if [[ -z "$(git diff --cached)" ]]; then
      echo "ERROR: index empty — nothing staged to review." >&2
      exit 1
    fi
    {
      echo "Review the following STAGED diff (pre-commit semantics)."
      echo "Inline content only; you have no file-system tools."
      echo "Skip protocol Steps 0-2. Execute Steps 3-11. Emit prose"
      echo "summary AND the fenced adversary-review YAML block."
      echo
      echo "Set these artifact fields verbatim in the YAML block:"
      echo "  path: STAGED"
      echo "  lines_reviewed: all"
      echo "Leave artifact.sha256 unset (no single artifact to hash)."
      echo
      echo "=== git diff --stat --cached ==="
      git diff --stat --cached
      echo
      echo "=== git diff --cached ==="
      git diff --cached
    } > "$PAYLOAD"
    ;;
  RANGE:*)
    if ! git rev-parse --is-inside-work-tree &>/dev/null; then
      echo "ERROR: RANGE target requires a git repository (CWD: $(pwd))" >&2
      exit 1
    fi
    RANGE_SPEC="${TARGET#RANGE:}"
    if [[ -z "$RANGE_SPEC" || "$RANGE_SPEC" != *..* ]]; then
      echo "ERROR: RANGE target must be 'RANGE:A..B' (got '$TARGET')" >&2
      exit 1
    fi
    if ! git rev-parse --verify --quiet "${RANGE_SPEC%%..*}" >/dev/null || \
       ! git rev-parse --verify --quiet "${RANGE_SPEC##*..}" >/dev/null; then
      echo "ERROR: one or both refs in '$RANGE_SPEC' do not resolve" >&2
      exit 1
    fi
    if [[ -z "$(git diff "$RANGE_SPEC")" ]]; then
      echo "ERROR: no diff in range $RANGE_SPEC — nothing to review." >&2
      exit 1
    fi
    {
      echo "Review the following commit-range diff ($RANGE_SPEC)."
      echo "Inline content only; you have no file-system tools."
      echo "Skip protocol Steps 0-2. Execute Steps 3-11. Emit prose"
      echo "summary AND the fenced adversary-review YAML block."
      echo
      echo "Set these artifact fields verbatim in the YAML block:"
      echo "  path: $RANGE_SPEC"
      echo "  lines_reviewed: all"
      echo "Leave artifact.sha256 unset (no single artifact to hash)."
      echo
      echo "=== git diff --stat $RANGE_SPEC ==="
      git diff --stat "$RANGE_SPEC"
      echo
      echo "=== git diff $RANGE_SPEC ==="
      git diff "$RANGE_SPEC"
    } > "$PAYLOAD"
    ;;
  *)
    if [[ ! -f "$TARGET" ]]; then
      echo "ERROR: target not found: $TARGET" >&2
      echo "       Pass a file path, 'HEAD', or 'STAGED'." >&2
      exit 1
    fi
    # Compute the real SHA-256 so the model can copy it verbatim into
    # artifact.sha256 instead of hallucinating. First 16 chars is the
    # SKILL.md convention.
    TARGET_SHA=$(shasum -a 256 "$TARGET" | awk '{print substr($1, 1, 16)}')
    TARGET_LINES=$(wc -l < "$TARGET" | tr -d ' ')
    {
      echo "Review the following source file as your sole work unit."
      echo "Inline content only; you have no file-system tools."
      echo "Skip protocol Steps 0-2 (mechanical baseline, claim"
      echo "verification, test verification). Execute Steps 3-11"
      echo "(Complexity, Scope, Alternatives, Assumptions, Security,"
      echo "Verdict). Emit prose summary AND the fenced"
      echo "adversary-review YAML block."
      echo
      echo "Set these artifact fields verbatim in the YAML block:"
      echo "  path: ${TARGET}"
      echo "  sha256: ${TARGET_SHA}"
      echo "  lines_reviewed: 1-${TARGET_LINES}"
      echo
      echo "=== FILE: ${TARGET} ==="
      cat "$TARGET"
      echo "=== END FILE ==="
    } > "$PAYLOAD"
    ;;
esac

echo "================================================"
echo "  ADVERSARY PASS"
echo "  Target:    $TARGET"
echo "  Model:     ${PROVIDER}/${MODEL}"
echo "  Timestamp: $TIMESTAMP"
echo "  Payload:   $(wc -l < "$PAYLOAD") lines, $(wc -c < "$PAYLOAD") bytes"
echo "================================================"
echo ""

# --- Stage 1: Primary adversary review ---
# Deterministic single-turn pi: every autoload off, skill loaded
# explicitly via --append-system-prompt.
run_pi() {
  local extra_user="$1"
  pi \
    --no-extensions \
    --no-tools \
    --no-skills \
    --no-prompt-templates \
    --no-context-files \
    --no-session \
    --provider "$PROVIDER" \
    --model "$MODEL" \
    --append-system-prompt "$SKILL_PATH" \
    -p "$(cat "$PAYLOAD")${extra_user}" 2>&1
}

REVIEW=$(run_pi "") || true

echo "$REVIEW"
echo ""

# Write review artifact (Enqueue-Before-Ack: persist before acting).
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
# Prefer the YAML block's `verdict:` (authoritative per SKILL.md).
# Fall back to the prose `**VERDICT: …**` if YAML absent.
# `|| true` on each pipeline so an empty $REVIEW (e.g. model emitted
# nothing) doesn't make grep return 1, which pipefail would propagate
# and `set -e` would convert into a script abort — bypassing the
# cascading fallbacks below.
VERDICT=$(echo "$REVIEW" | grep -E '^verdict:[[:space:]]*(PASS|CONCERNS|FAIL)\b' \
            | head -1 | grep -oE 'PASS|CONCERNS|FAIL' | head -1 || true)
if [[ -z "$VERDICT" ]]; then
  VERDICT=$(echo "$REVIEW" | grep -E '\*\*VERDICT:|\*\*PASS\*\*|\*\*CONCERNS\*\*|\*\*FAIL\*\*' \
              | head -1 | grep -oE 'PASS|CONCERNS|FAIL' | head -1 || true)
fi
[[ -z "$VERDICT" ]] && VERDICT="UNKNOWN"

echo "Verdict: $VERDICT"
# Emit the resolved model so wrappers (adversary-loop.sh) can attribute
# the capture to the model actually used, after --model/--adapter/--domain
# resolution -- not a guessed default.
echo "Model: $MODEL"
echo "Review written to: $REVIEW_FILE"

# --- Stage 1a: Prose/YAML drift check (informational, never blocks) ---
# Re-parses the review file we just wrote and flags any prose section
# that still uses "no issues" boilerplate when the YAML lists findings
# of the matching category. Appends a "Pipeline Drift Warning" block
# to the review file on disagreement. Does NOT change the verdict or
# YAML — see tools/ts/drift-check.ts.
#
# Runs BEFORE Stage 1b (capture) so any appended warning is part of the
# review body the capture pipeline serialises.
#
# ADV_NO_DRIFT_CHECK: when set (non-empty), skip the check.
DRIFT_SH=""
for c in "$(dirname "${BASH_SOURCE[0]}")/drift-check.sh" \
         "$HOME/.pi/agent/tools/drift-check.sh"; do
  if [[ -x "$c" ]]; then DRIFT_SH="$c"; break; fi
done
if [[ -n "${ADV_NO_DRIFT_CHECK:-}" ]]; then
  echo "drift-check: skipped (ADV_NO_DRIFT_CHECK set)"
elif [[ -n "$DRIFT_SH" ]]; then
  "$DRIFT_SH" --review "$REVIEW_FILE" 2>&1 || \
    echo "drift-check: helper failed (non-fatal)"
fi

# --- Stage 1b: Bootstrap capture (informational, never blocks) ---
# Feeds ~/.pi/agent/training/adversary-captures/bootstrap.jsonl for
# pre-adapter corpus seeding. Falls back silently if the helper is
# absent (e.g. installs without tsx available).
#
# ADV_NO_CAPTURE: when set (non-empty), skip the capture entirely.
# Default behaviour (unset) is unchanged. A multi-pass driver
# (adversary-loop.sh) sets this on intermediate iterations so only the
# converged record lands in the corpus -- intermediate, pre-convergence
# reviews are low quality and would dilute the training signal.
CAPTURE_SH=""
for c in "$(dirname "${BASH_SOURCE[0]}")/capture-review.sh" \
         "$HOME/.pi/agent/tools/capture-review.sh"; do
  if [[ -x "$c" ]]; then CAPTURE_SH="$c"; break; fi
done
if [[ -n "${ADV_NO_CAPTURE:-}" ]]; then
  echo "capture: skipped (ADV_NO_CAPTURE set)"
elif [[ -n "$CAPTURE_SH" ]]; then
  CAPTURE_ARGS=(
    --review "$REVIEW_FILE"
    --scope  "$TARGET"
    --model  "$MODEL"
    --temperature 0
  )
  if [[ -f "$TARGET" ]]; then
    CAPTURE_ARGS+=(--artifact-path "$TARGET")
  fi
  if git rev-parse HEAD &>/dev/null; then
    CAPTURE_ARGS+=(--git-sha "$(git rev-parse HEAD)")
  fi
  "$CAPTURE_SH" "${CAPTURE_ARGS[@]}" 2>&1 || \
    echo "capture: helper failed (non-fatal)"
fi
echo ""

# --- Stage 2: Quorum (if CONCERNS or FAIL) ---
if [[ "$QUORUM" -eq 1 ]] && [[ "$VERDICT" == "CONCERNS" || "$VERDICT" == "FAIL" ]]; then
  echo "--- Quorum: spawning peer adversaries ---"
  echo ""

  PEER_VERDICTS=("$VERDICT")
  FINAL_VERDICT="$VERDICT"

  for peer in 1 2; do
    echo "  Peer ${peer}..."
    # QUORUM_PEER token tells the skill prompt to short-circuit
    # (see SKILL.md Step 8). Appended to the inlined payload so the
    # peer also has the target context.
    PEER_REVIEW=$(run_pi $'\n\nQUORUM_PEER peer-'"${peer}"$': Return ONLY: VERDICT line and top 1–3 findings with file:line.') || true

    PEER_VERDICT=$(echo "$PEER_REVIEW" | grep -E 'VERDICT:|^verdict:' \
                     | head -1 | grep -oE 'PASS|CONCERNS|FAIL' | head -1 || echo "UNKNOWN")

    PEER_VERDICTS+=("$PEER_VERDICT")
    echo "  Peer ${peer} verdict: $PEER_VERDICT"

    {
      echo ""
      echo "---"
      echo "## Quorum Peer ${peer}"
      echo ""
      echo "$PEER_REVIEW"
    } >> "$REVIEW_FILE"

    # Early exit: first peer agrees → quorum confirmed.
    if [[ "$PEER_VERDICT" == "CONCERNS" || "$PEER_VERDICT" == "FAIL" ]]; then
      echo "Quorum confirmed: self=${VERDICT}, peer${peer}=${PEER_VERDICT}"
      break
    fi

    if [[ "$peer" -eq 2 ]]; then
      PASS_COUNT=$(printf '%s\n' "${PEER_VERDICTS[@]}" | grep -c 'PASS' || true)
      if [[ "$PASS_COUNT" -ge 2 ]]; then
        FINAL_VERDICT="CONCERNS"
        echo "Quorum: peers downgrade ${VERDICT} → CONCERNS"
      else
        echo "Quorum: ${VERDICT} confirmed"
      fi
    fi
  done

  VERDICT="$FINAL_VERDICT"
  echo "" >> "$REVIEW_FILE"
  echo "**Final Verdict (post-quorum)**: ${VERDICT}" >> "$REVIEW_FILE"
fi

# --- Stage 3: Revision (optional, known-limited headless) ---
if [[ "$REVISE" -eq 1 ]] && [[ "$VERDICT" == "CONCERNS" || "$VERDICT" == "FAIL" ]]; then
  echo ""
  echo "--- Revision pass (verdict was ${VERDICT}) ---"
  echo "WARNING: revise needs file-system tools, which require pi's" >&2
  echo "         interactive mode. Headless revise in pi 0.74.0 is" >&2
  echo "         not reliable; consider running pi interactively to" >&2
  echo "         apply findings from ${REVIEW_FILE}." >&2
  echo ""

  pi \
    --provider "$PROVIDER" \
    --model "$MODEL" \
    -p "Revise @${TARGET} to address all findings in @${REVIEW_FILE}.
Do not add scope. Do not add abstractions not required by the findings.
Follow the TDD mandate: write or update tests first, then fix implementation." \
    2>&1 || true

  echo ""
  echo "Revision attempt complete. Re-run adversary-pass.sh to verify."
fi

echo ""
echo "================================================"
echo "  DONE: ${VERDICT}"
echo "================================================"

exit 0
