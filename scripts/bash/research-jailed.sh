#!/usr/bin/env bash
#
# research-jailed.sh -- Run a TOOL-ENABLED research worker inside the
# research-mode read-only jail.
#
# This is the general-purpose sibling of adversary-jailed.sh: instead of
# reviewing a fixed file, it carries out a FREE-FORM research/analysis task
# given as a prompt. The worker navigates the codebase itself with read-only
# tools — the harness physically prevents it from writing outside its workspace:
#
#   - tools restricted to: read, grep, find, ls, bash-safe, write-research
#   - --research activates the jail (write/edit/raw-bash disabled; bash-safe is
#     an allow-only runner; cp only into the scratch workspace)
#   - only the research-mode extension is loaded (-e), so quorum/adversary-hook
#     do not fire and inflate the turn
#
# Unlike adversary-jailed.sh there is no Step-0 mechanical baseline and no
# quorum — those are review-of-a-target concepts. The worker's system prompt is
# the `research` skill (grounded, evidence-first, read-only contract).
#
# Usage:
#   research-jailed.sh "<prompt>"                    # run a research task
#   research-jailed.sh "<prompt>" --out-dir <dir>    # write the report under <dir>
#   research-jailed.sh "<prompt>" --label <slug>     # name the report file
#
# Workspace: PI_RESEARCH_WORKSPACE, if set, is inherited by the child pi, pinning
# it to the invoker's workspace (so a worker dispatched from a jailed session
# writes into THAT same workspace rather than a fresh temp dir). The dispatcher's
# report follows the same env var.
#
# Output dir: --out-dir wins; else $PI_RESEARCH_WORKSPACE/reports when that env
# is set; else ./reports.
#
# NOTE: pi 0.77 fixed the print-mode tool loop (verified 2026-05-30). The local
# thinking model can still exhaust its token budget on large inputs — keep the
# task SCOPED for now.
#
# Output: <dir>/<label>-<timestamp>.md (the worker's prose report).
# Always exits 0 (informational, not a gate).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PROMPT="${1:?Usage: research-jailed.sh \"<prompt>\" [--out-dir <dir>] [--label <slug>]}"
shift

OUT_DIR_OVERRIDE=""
LABEL="research"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir) OUT_DIR_OVERRIDE="${2:?--out-dir needs a directory}"; shift ;;
    --label)   LABEL="${2:?--label needs a slug}"; shift ;;
    *)         echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

# --- Model / provider (mirror adversary-jailed.sh) ---
# macOS reports arm64; the Linux container-harness guest reports aarch64. Both
# reach the host MLX on :18080 (forwarded via socat inside the container), so
# both take the local-mlx path — only a genuinely other arch (x86) → ollama.
if [[ "$(uname -m)" == "arm64" || "$(uname -m)" == "aarch64" ]]; then
  MODEL="${PI_RESEARCH_WORKER_MODEL:-$HOME/models/Qwen3.5-27B-4bit}"
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

# --- Resolve the research skill (sole system prompt) ---
SKILL_PATH="${HOME}/.pi/agent/skills/research/SKILL.md"
[[ -f "$SKILL_PATH" ]] || SKILL_PATH="skills/research/SKILL.md"
if [[ ! -f "$SKILL_PATH" ]]; then
  echo "ERROR: research SKILL.md not found (run install.sh)." >&2
  exit 1
fi

# --- Resolve the research-mode extension (provides the jail) ---
EXT_PATH="${HOME}/.pi/agent/extensions/research-mode.ts"
if [[ ! -f "$EXT_PATH" ]]; then
  echo "ERROR: research-mode.ts not found at $EXT_PATH (run install.sh)." >&2
  exit 1
fi

TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# Sanitize the label for use as a filename component (no slashes/spaces).
LABEL_SLUG=$(echo "$LABEL" | tr '/ ' '__' | tr -cd 'A-Za-z0-9._-')
[[ -z "$LABEL_SLUG" ]] && LABEL_SLUG="research"
# Output dir precedence: explicit --out-dir, then the invoker's research
# workspace (so a report from a jailed session lands IN that workspace, not the
# read-only repo), then the local ./reports default.
REPORT_DIR="${OUT_DIR_OVERRIDE:-${PI_RESEARCH_WORKSPACE:+$PI_RESEARCH_WORKSPACE/reports}}"
REPORT_DIR="${REPORT_DIR:-reports}"
REPORT_FILE="${REPORT_DIR}/${LABEL_SLUG}-${TIMESTAMP}.md"
mkdir -p "$REPORT_DIR"

read -r -d '' FULL_PROMPT <<EOF || true
You are a research worker in the research-mode jail: read-only repository +
bash-safe only (no writes outside your workspace, no shell, no code/test
execution). Navigate with read/grep/find/ls and bash-safe; persist notes,
copies, and your written analysis with write-research. Follow the research
protocol from your system prompt and produce a grounded, evidence-cited report.

Task:
${PROMPT}
EOF

# Jailed, tool-enabled, single research-mode extension only. If
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

REPORT=$(run_pi "$FULL_PROMPT") || true

echo "$REPORT"
echo ""

# --- Verify, then write. The runner owns only the cheap deterministic part:
#     confirm the worker produced something, and that the report file lands with
#     exactly the intended bytes (our own SHA-256). It retries the WRITE only,
#     never the worker; a no-output or persistent-write failure escalates to the
#     session agent instead of emitting a phantom "Report written to". --------
AV_LIB="${HOME}/.pi/agent/scripts/artifact-verify.sh"
[[ -f "$AV_LIB" ]] || AV_LIB="$SCRIPT_DIR/artifact-verify.sh"
# shellcheck source=/dev/null
source "$AV_LIB"

if ! av_substantive "$REPORT"; then
  echo "WORKER-FAILED: research worker produced no usable output — escalate to the session agent (re-run or adjust the task)." >&2
  echo "WORKER-FAILED: no usable output."
  exit 3
fi

CONTENT="$(
  printf '# Research Report (jailed, tool-enabled)\n\n'
  printf '**Task**: %s\n' "$PROMPT"
  printf '**Timestamp**: %s\n' "$TIMESTAMP"
  printf '**Model**: %s/%s\n' "$PROVIDER" "$MODEL"
  printf '**Mode**: research-mode jail (read,grep,find,ls,bash-safe,write-research)\n\n'
  printf '%s\n' "$REPORT"
)"

set +e
WANT="$(av_write_verified "$CONTENT" "$REPORT_FILE")"
rc=$?
set -e
if [[ "$rc" -eq 0 ]]; then
  echo "Report written to: ${REPORT_FILE}  (sha256=${WANT}, verified)"
  exit 0
fi
if [[ "$rc" -eq 2 ]]; then
  echo "WORKER-FAILED: could not run checksum verification (tool unavailable) — escalate to the session agent." >&2
else
  echo "WORKER-FAILED: report file did not verify after retry — escalate to the session agent." >&2
fi
echo "WORKER-FAILED: write unverified."
exit 4
