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
#   adversary-jailed.sh <path>                   # review a file or directory
#   adversary-jailed.sh <path> --quorum          # + 2 jailed peers on CONCERNS/FAIL
#   adversary-jailed.sh <path> --out-dir <dir>   # write the review under <dir>
#
# Quorum peers reuse the same jailed invocation (run_pi), so they have exactly
# the research-agent's authority — no raw shell, no repo writes. Only the
# primary's CONCERNS/FAIL verdict triggers them; the policy is conservative —
# two PASS peers downgrade a FAIL/CONCERNS primary by one step (FAIL->CONCERNS)
# but never clear it to PASS, mirroring adversary-pass.sh.
#
# Output dir: --out-dir wins; else $PI_RESEARCH_WORKSPACE/reviews when that env
# is set (so a review launched from a jailed session lands in that workspace,
# not the read-only repo); else ./reviews. When PI_RESEARCH_WORKSPACE is set it
# is also inherited by the child pi, pinning it to the invoker's workspace.
#
# NOTE: pi 0.77 fixed the print-mode tool loop that forced adversary-pass.sh to
# be toolless (verified 2026-05-30). The local thinking-adversary model can
# still exhaust its token budget on large inputs — keep targets SMALL for now.
#
# Output: <dir>/<label>-jailed-<timestamp>.md (prose + fenced adversary-review YAML).
# Always exits 0 (informational, not a gate).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TARGET="${1:?Usage: adversary-jailed.sh <path> [--quorum] [--out-dir <dir>]}"
shift

QUORUM=0
REVIEW_DIR_OVERRIDE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --quorum)  QUORUM=1 ;;
    --out-dir) REVIEW_DIR_OVERRIDE="${2:?--out-dir needs a directory}"; shift ;;
    *)         echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

# --- Model / provider (mirror adversary-pass.sh) ---
# macOS reports arm64; the Linux container-harness guest reports aarch64. Both
# reach the host MLX on :18080 (forwarded via socat inside the container), so
# both take the local-mlx path — only a genuinely other arch (x86) → ollama.
if [[ "$(uname -m)" == "arm64" || "$(uname -m)" == "aarch64" ]]; then
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
# Output dir precedence: explicit --out-dir, then the invoker's research
# workspace (so a review launched from a jailed session lands IN that workspace,
# not the read-only repo), then the local ./reviews default.
REVIEW_DIR="${REVIEW_DIR_OVERRIDE:-${PI_RESEARCH_WORKSPACE:+$PI_RESEARCH_WORKSPACE/reviews}}"
REVIEW_DIR="${REVIEW_DIR:-reviews}"
REVIEW_FILE="${REVIEW_DIR}/${TARGET_LABEL}-jailed-${TIMESTAMP}.md"
mkdir -p "$REVIEW_DIR"

# --- Fail closed if the named target is not present ---
# A gate told to review a file it cannot find must FAIL (block the chain), not
# return an ambiguous UNKNOWN or a silent pass. This catches a not-yet-published
# artifact (a publish/visibility race with the prior stage) as well as a wrong
# path. Checked here, after REVIEW_DIR is known, so the verdict is recorded like
# any other review.
if [[ ! -e "$TARGET" ]]; then
  {
    echo "# Adversary Review (jailed, tool-enabled)"
    echo ""
    echo "**Target**: \`${TARGET}\`"
    echo "**Timestamp**: ${TIMESTAMP}"
    echo "**Mode**: research-mode jail (read,grep,find,ls,bash-safe,write-research)"
    echo ""
    echo "**VERDICT: FAIL** — review target not found."
    echo ""
    echo "The target \`${TARGET}\` does not exist where the reviewer runs. The gate"
    echo "cannot evaluate a file it was told exists, so it fails closed (FAIL) rather"
    echo "than returning UNKNOWN. Likely causes: a wrong path, or the prior stage's"
    echo "artifact was not durably published before this gate ran (a race)."
    echo ""
    echo "verdict: FAIL"
  } > "$REVIEW_FILE"
  echo "ERROR: review target '${TARGET}' not found — failing closed (FAIL)." >&2
  echo "Verdict: FAIL"
  echo "Review written to: ${REVIEW_FILE}"
  exit 0
fi

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

# Jailed, tool-enabled, single research-mode extension only. This IS the jailed
# invocation, so quorum peers built on it are jailed by construction (read-only
# repo + bash-safe + write-research; no raw shell, no repo writes). If
# PI_RESEARCH_WORKSPACE is set it is inherited here, so the child pins to the
# invoker's workspace rather than a fresh temp dir.
run_pi() {
  local prompt="$1"
  pi \
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
    -p "$prompt" 2>&1
}

REVIEW=$(run_pi "$PROMPT") || true

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

# --- Extract verdict (YAML preferred, prose fallback) — mirror adversary-pass.sh ---
VERDICT=$(echo "$REVIEW" | grep -E '^verdict:[[:space:]]*(PASS|CONCERNS|FAIL)\b' \
            | head -1 | grep -oE 'PASS|CONCERNS|FAIL' | head -1 || true)
if [[ -z "$VERDICT" ]]; then
  VERDICT=$(echo "$REVIEW" | grep -E '\*\*VERDICT:|\*\*PASS\*\*|\*\*CONCERNS\*\*|\*\*FAIL\*\*' \
              | head -1 | grep -oE 'PASS|CONCERNS|FAIL' | head -1 || true)
fi
# Fail closed: an adversary that produced no parseable verdict could not
# complete the review (empty/incomplete body — e.g. it couldn't read the target,
# or exhausted its token budget). A gate that cannot evaluate must BLOCK, not
# return an ambiguous UNKNOWN that risks being waved past.
if [[ -z "$VERDICT" ]]; then
  VERDICT="FAIL"
  {
    echo ""
    echo "> **Gate fail-closed:** the adversary produced no parseable verdict"
    echo "> (empty or incomplete review — could not read the target, or ran out of"
    echo "> token budget). Treated as FAIL so the chain blocks rather than proceeding"
    echo "> on an unreviewed artifact. Re-run; if it recurs, check the target is"
    echo "> readable and small enough for the reviewer."
  } >> "$REVIEW_FILE"
fi

# --- Quorum: jailed peer adversaries, only on CONCERNS/FAIL (mirror adversary-pass.sh stage 2) ---
if [[ "$QUORUM" -eq 1 ]] && [[ "$VERDICT" == "CONCERNS" || "$VERDICT" == "FAIL" ]]; then
  echo "--- Quorum: spawning jailed peer adversaries ---"
  echo ""
  PEER_VERDICTS=("$VERDICT")
  FINAL_VERDICT="$VERDICT"
  for peer in 1 2; do
    echo "  Peer ${peer}..."
    # QUORUM_PEER token + terse ask. Peers reuse run_pi, so they are jailed too.
    PEER_REVIEW=$(run_pi "${PROMPT}

QUORUM_PEER peer-${peer}: Return ONLY the VERDICT line and the top 1-3 findings with file:line.") || true
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
    # First peer that agrees → quorum confirmed.
    if [[ "$PEER_VERDICT" == "CONCERNS" || "$PEER_VERDICT" == "FAIL" ]]; then
      echo "Quorum confirmed: self=${VERDICT}, peer${peer}=${PEER_VERDICT}"
      break
    fi
    if [[ "$peer" -eq 2 ]]; then
      PASS_COUNT=$(printf '%s\n' "${PEER_VERDICTS[@]}" | grep -c 'PASS' || true)
      if [[ "$PASS_COUNT" -ge 2 ]]; then
        FINAL_VERDICT="CONCERNS"
        echo "Quorum: peers downgrade ${VERDICT} -> CONCERNS"
      else
        echo "Quorum: ${VERDICT} confirmed"
      fi
    fi
  done
  VERDICT="$FINAL_VERDICT"
  {
    echo ""
    echo "**Final Verdict (post-quorum)**: ${VERDICT}"
  } >> "$REVIEW_FILE"
fi

echo "Verdict: ${VERDICT}"
echo "Review written to: ${REVIEW_FILE}"
exit 0
