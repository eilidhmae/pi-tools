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
# Components installed (source path → install path under $PI_AGENT_DIR,
# which is ~/.pi/agent/ in global mode and <repo>/.pi/agent/ in --local
# mode; shell scripts go to $PI_AGENT_DIR/tools/ in global mode and
# <repo>/tools/bash/ in --local mode):
#
#   AGENTS.md                                  → AGENTS.md
#   skills/<name>/SKILL.md                     → skills/<name>/SKILL.md  (/skill:<name>)
#   prompts/adversary-review.md                → prompts/adversary-review.md  (/adversary-review)
#   extensions/adversary-hook.ts               → extensions/adversary-hook.ts  (PostWrite check)
#   extensions/quorum.ts                       → extensions/quorum.ts  (adversary quorum)
#   extensions/lib/*.ts                        → extensions/lib/*.ts  (helper modules)
#   tools/bash/adversary-check.sh              → tools/adversary-check.sh
#   tools/bash/adversary-pass.sh               → tools/adversary-pass.sh
#   tools/bash/adversary-scan.sh               → tools/adversary-scan.sh
#   tools/bash/adversary-loop.sh               → tools/adversary-loop.sh
#   tools/bash/capture-review.sh               → tools/capture-review.sh
#   tools/bash/gen-review-revise.sh            → tools/gen-review-revise.sh
#   tools/ts/capture-review.ts                 → tools/ts/capture-review.ts
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

# Research mode extensions (optional, for secure read-only scanning)
install_file \
  "$SCRIPT_DIR/extensions/research-mode.ts" \
  "$PI_AGENT_DIR/extensions/research-mode.ts"

install_file \
  "$SCRIPT_DIR/extensions/research-mode-command.ts" \
  "$PI_AGENT_DIR/extensions/research-mode-command.ts"

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
  "$SCRIPT_DIR/tools/bash/adversary-loop.sh" \
  "${TOOLS_DIR}/adversary-loop.sh"
chmod +x "${TOOLS_DIR}/adversary-loop.sh"

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

# --- Ensure pi models.json has the local-mlx provider on arm64 ---
# Derived from PI_AGENT_DIR so --local installs land in the repo and global
# installs land under $HOME.
#
# Apple Silicon is the intended target for the pi-tools harness. On arm64
# we make sure models.json contains the local-mlx provider (merged from
# the template if the file already exists and lacks it). The autodetect
# previously gated this on :18080 being up at install time, but that's a
# chicken-and-egg on a fresh box — bootstrap-mac.sh + mlx-server.sh up
# come *after* install.sh, so the install has to configure the intended
# target, not the observed-running state.
MODELS_JSON="${PI_AGENT_DIR}/models.json"
TEMPLATE="$SCRIPT_DIR/server/models.json.template"
IS_ARM64=0
[[ "$(uname -m)" == "arm64" ]] && IS_ARM64=1

# local-mlx baseUrls below use 127.0.0.1 instead of localhost on purpose.
# On macOS /etc/hosts maps localhost to both 127.0.0.1 and ::1; mlx_lm.server
# binds IPv4 only. Symptom seen with pi 0.75.5 (Node 26, openai-js 6.26.0)
# pointed at `localhost`: TCP socket opens but no HTTP POST is ever written,
# server log stays silent, GPU idle, pi hangs with zero stdout. Switching
# the client to 127.0.0.1 sidesteps the dual-stack lookup and the request
# goes through. Root cause not isolated (suspect happy-eyeballs handling
# in the openai-js HTTP agent); workaround applied at the client side.
# Verify by tailing the launcher log for the POST while a scan runs
# (server/thinking-adversary/logs/server.log for the thinking sidecar,
# per-port logs under server/mlx-lm-multi/ for the SFT stack).
# The ollama branch below intentionally keeps `localhost` -- it only fires
# on non-Apple hosts where the dual-stack symptom hasn't been observed.
if [[ ! -f "$MODELS_JSON" ]]; then
  echo ""
  echo "=== models.json not found at ${MODELS_JSON} — installing template ==="
  mkdir -p "$(dirname "$MODELS_JSON")"
  if [[ -f "$TEMPLATE" ]]; then
    # Expand $HOME at install time so the resulting models.json contains
    # the operator's actual home path (pi sends model ids verbatim to
    # mlx_lm.server, which resolves them as paths; an unexpanded "$HOME"
    # in the runtime config would not work). Substitution is limited to
    # the literal token "$HOME"; other $ references in the template (if
    # any are added later) pass through untouched. Same -i-free pattern
    # used by server/mlx-lm-multi/proxy.service.plist for _REPLACE_USER_.
    sed "s|\$HOME|$HOME|g" "$TEMPLATE" > "$MODELS_JSON"
    echo "  Created: $MODELS_JSON  (local-mlx + contrast providers)"
  elif [[ "$IS_ARM64" -eq 1 ]]; then
    # Template missing on arm64: write a minimal local-mlx config, not the
    # ollama-only fallback. ollama has no role on Apple Silicon (same base
    # model via a different runtime, can't load the per-role adapters).
    cat > "$MODELS_JSON" <<'EOF'
{
  "providers": {
    "local-mlx": {
      "baseUrl": "http://127.0.0.1:18080/v1",
      "api": "openai-completions",
      "apiKey": "local",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        { "id": "qwen3-coder-30b-a3b",           "name": "Qwen3-Coder 30B-A3B (base)",      "contextWindow": 262144 },
        { "id": "qwen3-coder-30b-a3b+adversary", "name": "Qwen3-Coder 30B-A3B + Adversary", "contextWindow": 262144 }
      ]
    }
  }
}
EOF
    echo "  Created: $MODELS_JSON  (minimal local-mlx; template missing)"
  else
    # Non-Apple, template missing: ollama-only fallback.
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
    echo "  Created: $MODELS_JSON  (ollama-only fallback; template missing)"
  fi
elif [[ "$IS_ARM64" -eq 1 ]] && ! grep -q '"local-mlx"' "$MODELS_JSON" 2>/dev/null; then
  echo ""
  echo "=== Merging local-mlx provider into $MODELS_JSON ==="
  rc=0
  python3 - "$MODELS_JSON" "$TEMPLATE" <<'PYEOF' || rc=$?
import json, sys, shutil, time, os
target_path, template_path = sys.argv[1], sys.argv[2]
with open(target_path) as f:
    target = json.load(f)
with open(template_path) as f:
    template = json.load(f)
if not isinstance(target, dict):
    print(f"  SKIP: {target_path} is not a JSON object")
    sys.exit(2)
target.setdefault("providers", {})
if not isinstance(target["providers"], dict):
    print(f"  SKIP: {target_path}.providers is not an object")
    sys.exit(2)
# Only merge the primary local-mlx provider. Contrast providers
# (local-mlx-codestral, local-mlx-dscoder) require extra-models to be
# configured first and are added by the operator if/when wanted.
if "local-mlx" in template.get("providers", {}) and "local-mlx" not in target["providers"]:
    target["providers"]["local-mlx"] = template["providers"]["local-mlx"]
    backup = f"{target_path}.bak.{int(time.time())}"
    shutil.copy2(target_path, backup)
    with open(target_path, "w") as f:
        json.dump(target, f, indent=2)
        f.write("\n")
    print(f"  Added: local-mlx provider")
    print(f"  Backup: {backup}")
else:
    print("  Nothing to merge (template missing local-mlx, or already present)")
    sys.exit(3)
PYEOF
  case "$rc" in
    0|3) : ;;  # 0 = merged, 3 = already present — both fine
    *) echo "  WARNING: merge failed (python3 exit $rc); inspect $MODELS_JSON manually" ;;
  esac
fi

# --- Apple Silicon default provider/model ---
#
# pi 0.74.0's model resolver (core/model-resolver.js findInitialModel)
# falls through to "first available model" when no CLI flags, --models
# scoping, or settings.json defaults match. Neither `ollama` nor
# `local-mlx` are in pi's hardcoded defaultModelPerProvider list, so the
# default is decided by models.json declaration order — historically
# ollama-first, which is the wrong target on arm64.
#
# On arm64 we set defaultProvider=local-mlx + defaultModel=qwen3-coder-30b-a3b.
# We do clobber a pre-existing `ollama` default (because that's exactly
# the wrong-default bug we're fixing), but we leave any other explicit
# defaultProvider value alone so operators can pin a different target.
# Set PI_TOOLS_KEEP_DEFAULTS=1 to suppress the rewrite entirely.
SETTINGS_JSON="${PI_AGENT_DIR}/settings.json"
if [[ "$IS_ARM64" -eq 1 ]] && [[ -z "${PI_TOOLS_KEEP_DEFAULTS:-}" ]]; then
  rc=0
  python3 - "$SETTINGS_JSON" <<'PYEOF' || rc=$?
import json, os, sys, shutil, time
path = sys.argv[1]
data = {}
existed = os.path.exists(path)
if existed:
    try:
        with open(path) as f:
            data = json.load(f)
        if not isinstance(data, dict):
            data = {}
    except Exception:
        data = {}
current_provider = data.get("defaultProvider")
current_model = data.get("defaultModel")
# Overwrite when:
#   - no defaults are set, OR
#   - defaults currently point at ollama (the wrong-target bug).
# Leave any other explicit value alone.
ollama_defaults = {None, "", "ollama"}
provider_ok_to_overwrite = current_provider in ollama_defaults
model_ok_to_overwrite = current_model in ollama_defaults | {"qwen3-coder", "qwen3-coder:30b", "qwen3-coder-next"}
if not (provider_ok_to_overwrite and model_ok_to_overwrite):
    print(f"  NOTE: {path} has non-ollama defaults (provider={current_provider!r}, model={current_model!r}); leaving as-is.")
    print("        Set PI_TOOLS_KEEP_DEFAULTS=1 to silence; delete the keys to force overwrite.")
    sys.exit(2)
if existed:
    backup = f"{path}.bak.{int(time.time())}"
    shutil.copy2(path, backup)
    print(f"  Backup: {backup}")
data["defaultProvider"] = "local-mlx"
data["defaultModel"] = "qwen3-coder-30b-a3b"
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
print(f"  Set: defaultProvider=local-mlx, defaultModel=qwen3-coder-30b-a3b")
PYEOF
  case "$rc" in
    0)
      echo ""
      echo "=== Updated $SETTINGS_JSON for Apple Silicon ==="
      ;;
    2)
      : ;;  # python already printed the note
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
echo "   ${TOOLS_DIR}/adversary-pass.sh <file>          # headless adversary pipeline"
echo "   ${TOOLS_DIR}/adversary-pass.sh <file> --quorum # with manual quorum"
echo "   ${TOOLS_DIR}/gen-review-revise.sh <spec.md>    # full generate→review→revise"
echo ""
echo "   (Add ${TOOLS_DIR} to PATH in your shell rc to invoke by bare name.)"
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
echo " Optional research extensions (use with -e flag):"
echo "   research-mode.ts           (auto-activate on session start)"
echo "     pi -e ~/.pi/agent/extensions/research-mode.ts -p 'Analyze this'"
echo ""
echo "   research-mode-command.ts   (on-demand via /research-mode)"
echo "     pi -e ~/.pi/agent/extensions/research-mode-command.ts"
echo "     Then type: /research-mode  (to activate mid-session)"
echo ""
echo " See extensions/README.md for full documentation."
echo ""
echo " qwen3-coder note:"
echo "   Non-thinking mode only — no <think> blocks."
echo "   Step-by-step structure in skill prompts is the reasoning scaffold."
echo ""
echo " To verify:"
echo "   pi /adversary-review"
echo "   pi /skill:adversary"
echo ""
