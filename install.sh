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
#   tools/bash/adversary-scan.sh               Scope-inferring scan wrapper
#   tools/bash/gen-review-revise.sh            Generate → review → revise
#
# Also chmod+x the in-repo server launcher (not installed elsewhere —
# invoke it directly from the pi-tools checkout):
#
#   server/mlx-server.sh                       Qwen track + extra-models

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
# Real extensions (have `export default function (pi)`): live at
# extensions/*.ts and are auto-discovered by pi's extension loader.
install_file \
  "$SCRIPT_DIR/extensions/adversary-hook.ts" \
  "$PI_AGENT_DIR/extensions/adversary-hook.ts"

install_file \
  "$SCRIPT_DIR/extensions/quorum.ts" \
  "$PI_AGENT_DIR/extensions/quorum.ts"

# Library modules imported by the real extensions: live under
# extensions/lib/ so pi's flat-glob extension discovery does NOT try to
# load them as plugins (which would error with "no valid factory
# function"). pi's discovery is empirically non-recursive, verified on
# pi 0.74.0.
install_file \
  "$SCRIPT_DIR/extensions/lib/adapter-route.ts" \
  "$PI_AGENT_DIR/extensions/lib/adapter-route.ts"

install_file \
  "$SCRIPT_DIR/extensions/lib/adversary-parse.ts" \
  "$PI_AGENT_DIR/extensions/lib/adversary-parse.ts"

install_file \
  "$SCRIPT_DIR/extensions/lib/adversary-capture.ts" \
  "$PI_AGENT_DIR/extensions/lib/adversary-capture.ts"

# Clean up pre-reorg paths if present (upgrade path).
for stale in adapter-route.ts adversary-parse.ts adversary-capture.ts; do
  rm -f "$PI_AGENT_DIR/extensions/$stale"
done

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
  "$SCRIPT_DIR/tools/bash/adversary-scan.sh" \
  "${TOOLS_DIR}/adversary-scan.sh"
chmod +x "${TOOLS_DIR}/adversary-scan.sh"

install_file \
  "$SCRIPT_DIR/tools/bash/capture-review.sh" \
  "${TOOLS_DIR}/capture-review.sh"
chmod +x "${TOOLS_DIR}/capture-review.sh"

# capture-review.sh delegates to a tsx-runnable TS file. Install it at
# $TOOLS_DIR/ts/ so the wrapper's first-candidate path resolves.
install_file \
  "$SCRIPT_DIR/tools/ts/capture-review.ts" \
  "${TOOLS_DIR}/ts/capture-review.ts"

install_file \
  "$SCRIPT_DIR/tools/bash/gen-review-revise.sh" \
  "${TOOLS_DIR}/gen-review-revise.sh"
chmod +x "${TOOLS_DIR}/gen-review-revise.sh"

# --- Make in-repo server launchers executable (no copy; invoke from repo) ---
# mlx-server.sh and the mlx-lm-multi/mola launchers reference each other
# by SCRIPT_DIR-relative paths, so they must run from the pi-tools tree.
# Installing them under ~/.pi/agent/ would break those relative paths.
if [[ -f "$SCRIPT_DIR/server/mlx-server.sh" ]]; then
  chmod +x "$SCRIPT_DIR/server/mlx-server.sh"
fi
for sh in "$SCRIPT_DIR/server/mlx-lm-multi"/*.sh "$SCRIPT_DIR/server/mola"/*.sh; do
  [[ -f "$sh" ]] && chmod +x "$sh"
done

# --- Verify pi models.json has ollama and (optionally) local-mlx configured ---
# Derived from PI_AGENT_DIR so --local installs land in the repo and global
# installs land under $HOME.
MODELS_JSON="${PI_AGENT_DIR}/models.json"
TEMPLATE="$SCRIPT_DIR/server/models.json.template"
if [[ ! -f "$MODELS_JSON" ]]; then
  echo ""
  echo "=== models.json not found at ${MODELS_JSON} — installing template (ollama + local-mlx) ==="
  mkdir -p "$(dirname "$MODELS_JSON")"
  if [[ -f "$TEMPLATE" ]]; then
    cp "$TEMPLATE" "$MODELS_JSON"
  else
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
  fi
  echo "  Created: $MODELS_JSON"
elif ! grep -q "qwen3-coder" "$MODELS_JSON" 2>/dev/null; then
  echo ""
  echo "WARNING: $MODELS_JSON exists but does not reference qwen3-coder."
  echo "         Add qwen3-coder:30b to the ollama provider manually if needed."
elif ! grep -q "local-mlx" "$MODELS_JSON" 2>/dev/null; then
  echo ""
  echo "NOTE: $MODELS_JSON does not include the local-mlx provider."
  echo "      To use LoRA adapters on Apple Silicon, merge the local-mlx"
  echo "      block from: $TEMPLATE"
fi

# --- Apple Silicon + local-mlx autodetect: seed default provider/model ---
#
# pi 0.74.0's model resolver (core/model-resolver.js findInitialModel) falls
# through to "first available model" when no CLI flags, --models scoping, or
# settings.json defaults match. Neither `ollama` nor `local-mlx` are in pi's
# hardcoded defaultModelPerProvider list, so the first available model is
# picked by iteration order — landing on whichever provider is declared first
# in models.json (almost always `ollama` per the template). That gives
# `pi /adversary-review` and similar prompt commands a 404 when ollama doesn't
# have `qwen3-coder:30b` pulled, even on machines where the whole rest of the
# harness expects local-mlx.
#
# Seed settings.json with the explicit defaults when:
#   - arch is arm64 (Apple Silicon), AND
#   - localhost:18080/v1/models responds within 1s (local-mlx server up).
# Existing defaultProvider/defaultModel values are preserved (never clobber
# operator config); other settings.json keys are merged through untouched.
SETTINGS_JSON="${PI_AGENT_DIR}/settings.json"
if [[ "$(uname -m)" == "arm64" ]] && \
   curl -fs --max-time 1 http://localhost:18080/v1/models >/dev/null 2>&1; then
  # `|| rc=$?` so `set -e` doesn't abort on the expected exit 2 path
  # (settings.json already has defaults the operator wants preserved).
  rc=0
  python3 - "$SETTINGS_JSON" <<'PYEOF' || rc=$?
import json, os, sys
path = sys.argv[1]
data = {}
if os.path.exists(path):
    try:
        with open(path) as f:
            data = json.load(f)
        if not isinstance(data, dict):
            data = {}
    except Exception:
        data = {}
if data.get("defaultProvider") or data.get("defaultModel"):
    sys.exit(2)
data["defaultProvider"] = "local-mlx"
data["defaultModel"] = "qwen3-coder-30b-a3b"
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PYEOF
  case "$rc" in
    0)
      echo ""
      echo "=== Seeded default provider/model in $SETTINGS_JSON ==="
      echo "    local-mlx + qwen3-coder-30b-a3b (Apple Silicon + local-mlx reachable)."
      ;;
    2)
      echo ""
      echo "NOTE: $SETTINGS_JSON already sets defaultProvider/defaultModel — leaving as-is."
      ;;
    *)
      echo ""
      echo "WARNING: could not update $SETTINGS_JSON (python3 exit $rc); skipping."
      ;;
  esac
fi

if [[ "$TARGET_MODE" == "local" ]]; then
  echo ""
  echo "NOTE: --local mode placed models.json at:"
  echo "  $MODELS_JSON"
  echo ""
  echo "      The pi binary's models.json discovery defaults to"
  echo "      ~/.pi/agent/models.json. Either symlink (copy-paste this line):"
  echo ""
  echo "  ln -s \"$MODELS_JSON\" \"$HOME/.pi/agent/models.json\""
  echo ""
  echo "      or invoke pi with an explicit --models-json path if your build"
  echo "      supports it."
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
echo " Server stack control (run from the pi-tools checkout):"
echo "   bash $SCRIPT_DIR/server/mlx-server.sh up      # Qwen + extras"
echo "   bash $SCRIPT_DIR/server/mlx-server.sh status  # listeners + health"
echo "   bash $SCRIPT_DIR/server/mlx-server.sh list    # configured tracks"
echo "   See $SCRIPT_DIR/server/extra-models/README.md to add a contrast model."
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
