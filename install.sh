#!/usr/bin/env bash
#
# install.sh -- Install pi-tools globally or project-local.
#
# Global install (default): writes to ~/.pi/agent/
#   bash install.sh
#
# Project-local install: writes to .pi/agent/ in current git repo
#   bash install.sh --local
#
# Options:
#   --local, --project   Install into ./.pi/agent/ instead of ~/.pi/agent/
#   --force, -y          Skip overwrite prompts
#   --help, -h           Show this help
#
# Components installed:
#
#   AGENTS.md                                  Shared rules (→ AGENTS.md)
#   skills/adversary/SKILL.md                  /skill:adversary
#   skills/manager/SKILL.md                    /skill:manager
#   skills/orchestrator/SKILL.md               /skill:orchestrator
#   skills/worker/SKILL.md                     /skill:worker
#   prompts/adversary-review.md                /adversary-review command
#   extensions/adversary-hook.ts               PostWrite mechanical check
#   extensions/quorum.ts                       Adversary quorum orchestrator
#   tools/bash/adversary-check.sh              Mechanical baseline (no LLM)
#   tools/bash/adversary-pass.sh               Adversary pipeline script
#   tools/bash/gen-review-revise.sh            Generate → review → revise

set -euo pipefail

TARGET_MODE="global"
FORCE=0

for arg in "$@"; do
  case "$arg" in
    --local|--project) TARGET_MODE="local" ;;
    --force|-y|--yes)  FORCE=1 ;;
    --help|-h)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *)
      echo "ERROR: Unknown argument: $arg" >&2
      echo "Usage: install.sh [--local] [--force]" >&2
      exit 1
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- Resolve install target ---
if [[ "$TARGET_MODE" == "local" ]]; then
  if ! git rev-parse --is-inside-work-tree &>/dev/null; then
    echo "ERROR: --local requires the current directory to be inside a git repo." >&2
    echo "       CWD: $(pwd)" >&2
    exit 1
  fi
  PI_AGENT_DIR="$(git rev-parse --show-toplevel)/.pi/agent"
  TOOLS_DIR="$(git rev-parse --show-toplevel)/tools/bash"
  echo "Installing project-local to: $PI_AGENT_DIR"
else
  PI_AGENT_DIR="${HOME}/.pi/agent"
  TOOLS_DIR="${HOME}/.pi/agent/tools"
  echo "Installing globally to: $PI_AGENT_DIR"
fi

# --- Helper functions ---

install_file() {
  local src="$1"
  local dst="$2"
  mkdir -p "$(dirname "$dst")"

  if [[ -f "$dst" && "$FORCE" -eq 0 ]]; then
    read -r -p "Overwrite $dst? [y/N] " resp
    case "$resp" in
      [yY]*) ;;
      *)
        echo "  Skipped: $dst"
        return
        ;;
    esac
  fi

  cp "$src" "$dst"
  echo "  Installed: $dst"
}

# --- Install components ---

echo ""
echo "=== AGENTS.md ==="
install_file "$SCRIPT_DIR/AGENTS.md" "$PI_AGENT_DIR/AGENTS.md"

echo ""
echo "=== Skills ==="
for skill in adversary manager orchestrator worker; do
  install_file \
    "$SCRIPT_DIR/skills/${skill}/SKILL.md" \
    "$PI_AGENT_DIR/skills/${skill}/SKILL.md"
done

echo ""
echo "=== Prompts ==="
install_file \
  "$SCRIPT_DIR/prompts/adversary-review.md" \
  "$PI_AGENT_DIR/prompts/adversary-review.md"

echo ""
echo "=== Extensions ==="
install_file \
  "$SCRIPT_DIR/extensions/adversary-hook.ts" \
  "$PI_AGENT_DIR/extensions/adversary-hook.ts"

install_file \
  "$SCRIPT_DIR/extensions/quorum.ts" \
  "$PI_AGENT_DIR/extensions/quorum.ts"

echo ""
echo "=== Tools ==="
install_file \
  "$SCRIPT_DIR/tools/bash/adversary-check.sh" \
  "${TOOLS_DIR}/adversary-check.sh"
chmod +x "${TOOLS_DIR}/adversary-check.sh"

install_file \
  "$SCRIPT_DIR/tools/bash/adversary-pass.sh" \
  "${TOOLS_DIR}/adversary-pass.sh"
chmod +x "${TOOLS_DIR}/adversary-pass.sh"

install_file \
  "$SCRIPT_DIR/tools/bash/gen-review-revise.sh" \
  "${TOOLS_DIR}/gen-review-revise.sh"
chmod +x "${TOOLS_DIR}/gen-review-revise.sh"

# --- Verify pi models.json has ollama configured ---
MODELS_JSON="${HOME}/.pi/agent/models.json"
if [[ ! -f "$MODELS_JSON" ]]; then
  echo ""
  echo "=== models.json not found — creating with ollama defaults ==="
  mkdir -p "$(dirname "$MODELS_JSON")"
  cat > "$MODELS_JSON" <<'EOF'
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        { "id": "qwen3-coder:30b" },
        { "id": "qwen3-coder-next" }
      ]
    }
  }
}
EOF
  echo "  Created: $MODELS_JSON"
elif ! grep -q "qwen3-coder" "$MODELS_JSON" 2>/dev/null; then
  echo ""
  echo "WARNING: $MODELS_JSON exists but does not reference qwen3-coder."
  echo "         Add qwen3-coder:30b to the ollama provider manually if needed."
fi

# --- Summary ---
echo ""
echo "=========================================="
echo " Installation complete."
echo "=========================================="
echo ""
echo " Invocation paths:"
echo ""
echo "   /adversary-review          # self-review checklist (prompt command)"
echo "   /skill:adversary           # full adversary review"
echo "   /skill:manager             # manager coordination session"
echo "   /skill:orchestrator        # orchestrator session"
echo "   /skill:worker              # worker implementation session"
echo ""
echo "   adversary-pass.sh <file>          # headless adversary pipeline"
echo "   adversary-pass.sh <file> --quorum # with manual quorum"
echo "   gen-review-revise.sh <spec.md>    # full generate→review→revise"
echo ""
echo " Extensions active in all pi sessions:"
echo "   adversary-hook.ts  (mechanical check after every write/edit)"
echo "   quorum.ts          (auto-quorum on CONCERNS/FAIL verdicts)"
echo ""
echo " qwen3-coder note:"
echo "   Non-thinking mode only — no <think> blocks."
echo "   Step-by-step structure in skill prompts is the reasoning scaffold."
echo ""
echo " To verify:"
echo "   pi /adversary-review"
echo "   pi /skill:adversary"
echo ""
