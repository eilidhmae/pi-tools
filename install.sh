#!/usr/bin/env bash
#
# install.sh -- Install pi-tools globally or project-local.
#
# Global install (default): writes to ~/.pi/agent/
#   bash install.sh
#
# Project-local install: writes to .pi/agent/ in the current directory (PWD)
#   bash install.sh --local
#
# Options:
#   --local, --project   Install into ./.pi/agent/ instead of ~/.pi/agent/
#   --force, -y          Skip overwrite prompts
#   --small, --tier-small  Force the small memory tier (27B serves all roles)
#   --large, --tier-large  Force the large memory tier (27B + 32B Code Worker)
#   --help, -h           Show this help
#
# Components installed (source path → install path under $PI_AGENT_DIR,
# which is ~/.pi/agent/ in global mode and ./.pi/agent/ (PWD) in --local
# mode; shell scripts go to $PI_AGENT_DIR/scripts/ in both modes —
# ~/.pi/agent/scripts/ globally, ./.pi/agent/scripts/ in --local):
#
#   AGENTS.md                                  → AGENTS.md
#   skills/<name>/SKILL.md                     → skills/<name>/SKILL.md  (/skill:<name>)
#   prompts/adversary-review.md                → prompts/adversary-review.md  (/adversary-review)
#   extensions/adversary-hook.ts               → extensions/adversary-hook.ts  (PostWrite check)
#   extensions/quorum.ts                       → extensions/quorum.ts  (adversary quorum)
#   extensions/adversary-review.ts             → extensions/adversary-review.ts  (adversary-review tool + /adversary-pass)
#   extensions/research-worker.ts              → extensions/research-worker.ts  (research-worker tool + /research)
#   extensions/planner-worker.ts               → extensions/planner-worker.ts  (planner-worker tool + /plan)
#   extensions/coder-worker.ts                 → extensions/coder-worker.ts  (coder-worker tool + /implement; writes the real repo, non-research only)
#   extensions/lib/*.ts                        → extensions/lib/*.ts  (helper modules)
#   scripts/bash/adversary-check.sh              → scripts/adversary-check.sh
#   scripts/bash/adversary-pass.sh               → scripts/adversary-pass.sh
#   scripts/bash/adversary-jailed.sh             → scripts/adversary-jailed.sh
#   scripts/bash/research-jailed.sh              → scripts/research-jailed.sh
#   scripts/bash/plan-jailed.sh                  → scripts/plan-jailed.sh
#   scripts/bash/coder-run.sh                    → scripts/coder-run.sh
#   scripts/bash/adversary-scan.sh               → scripts/adversary-scan.sh
#   scripts/bash/adversary-loop.sh               → scripts/adversary-loop.sh
#   scripts/bash/capture-review.sh               → scripts/capture-review.sh
#   scripts/bash/gen-review-revise.sh            → scripts/gen-review-revise.sh
#   scripts/bash/drift-check.sh                  → scripts/drift-check.sh
#   scripts/ts/capture-review.ts                 → scripts/ts/capture-review.ts
#   scripts/ts/drift-check.ts                    → scripts/ts/drift-check.ts
#
# Also chmod+x the in-repo server launcher (not installed elsewhere —
# invoke it directly from the pi-tools checkout):
#
#   server/mlx-server.sh                       Qwen track + extra-models

set -euo pipefail

TARGET_MODE="global"
FORCE=0
# Forced memory tier: empty = autodetect (default); "small"/"large" override the
# detection + PI_FORCE_MEM_GB logic below. An explicit flag wins over both.
FORCE_TIER=""

for arg in "$@"; do
  case "$arg" in
    --local|--project)      TARGET_MODE="local" ;;
    --force|-y|--yes)       FORCE=1 ;;
    --small|--tier-small)
      [[ -n "$FORCE_TIER" && "$FORCE_TIER" != "small" ]] && \
        { echo "ERROR: --small and --large are mutually exclusive" >&2; exit 1; }
      FORCE_TIER="small" ;;
    --large|--tier-large)
      [[ -n "$FORCE_TIER" && "$FORCE_TIER" != "large" ]] && \
        { echo "ERROR: --small and --large are mutually exclusive" >&2; exit 1; }
      FORCE_TIER="large" ;;
    --help|-h)
      sed -n '2,32p' "$0"
      exit 0
      ;;
    *)
      echo "ERROR: Unknown argument: $arg" >&2
      echo "Usage: install.sh [--local] [--force] [--small|--large]" >&2
      exit 1
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- Resolve install target ---
if [[ "$TARGET_MODE" == "local" ]]; then
  PI_AGENT_DIR="$(pwd)/.pi/agent"
  echo "Installing project-local to: $PI_AGENT_DIR"
else
  # Honour a pre-set PI_AGENT_DIR (used by tests to point at a throwaway
  # agent dir); otherwise default to the real global location. Warn loudly
  # when it's pre-set so a stale exported var can't silently misdirect a
  # global install.
  if [[ -n "${PI_AGENT_DIR:-}" ]]; then
    echo "WARNING: PI_AGENT_DIR is set in the environment — installing to"
    echo "         $PI_AGENT_DIR instead of ${HOME}/.pi/agent. Unset it for a default install."
  fi
  PI_AGENT_DIR="${PI_AGENT_DIR:-${HOME}/.pi/agent}"
  echo "Installing globally to: $PI_AGENT_DIR"
fi
# Scripts always live under the agent dir so the runtime's project-local
# resolver (<cwd>/.pi/agent/scripts/) and global resolver
# (~/.pi/agent/scripts/) both find them.
SCRIPTS_DIR="$PI_AGENT_DIR/scripts"

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

# Idempotently merge a single named provider from the template into an
# existing models.json. Additive only: if the provider is already present
# it does nothing (no backup churn, no dup). Backs up before writing.
#   $1 = models.json path   $2 = template path   $3 = provider key
# Echoes what it did. Returns 0 on merged-or-already-present; nonzero only
# on a real failure (caller decides whether that's fatal).
merge_provider() {
  local models_json="$1" template="$2" provider="$3" rc=0
  python3 - "$models_json" "$template" "$provider" <<'PYEOF' || rc=$?
import json, sys, shutil, time
target_path, template_path, provider = sys.argv[1], sys.argv[2], sys.argv[3]
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
if provider not in template.get("providers", {}):
    print(f"  SKIP: template has no provider {provider!r}")
    sys.exit(2)
if provider in target["providers"]:
    print(f"  Already present: {provider} (no change)")
    sys.exit(0)
# Expand $HOME the same way the fresh-install path does (sed s|$HOME|...|), so a
# provider whose model id is a local path (e.g. the 27B at $HOME/models/...) is
# merged with a real path rather than a literal "$HOME".
import os
_home = os.environ.get("HOME", "")
target["providers"][provider] = json.loads(
    json.dumps(template["providers"][provider]).replace("$HOME", _home)
)
backup = f"{target_path}.bak.{int(time.time())}"
shutil.copy2(target_path, backup)
with open(target_path, "w") as f:
    json.dump(target, f, indent=2)
    f.write("\n")
print(f"  Added: {provider} provider")
print(f"  Backup: {backup}")
PYEOF
  return "$rc"
}

# --- Install components ---

echo ""
echo "=== AGENTS.md ==="
install_file "$SCRIPT_DIR/AGENTS.md" "$PI_AGENT_DIR/AGENTS.md"

echo ""
echo "=== Skills ==="
for skill in adversary manager orchestrator worker research plan rpi; do
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

# Adversary review: the `adversary-review` tool (agent-invokable, gated by
# --tools) + the `/adversary-pass <file>` command. Both run a jailed adversary
# (adversary-jailed.sh) saving into the research workspace. Opt the tool in with
# --tools ...,adversary-review.
install_file \
  "$SCRIPT_DIR/extensions/adversary-review.ts" \
  "$PI_AGENT_DIR/extensions/adversary-review.ts"

# Research worker: the `research-worker` tool (agent-invokable, gated by --tools)
# + the `/research "<prompt>"` command. Both spawn a jailed research worker
# (research-jailed.sh) that writes its report into the research workspace. Opt
# the tool in with --tools ...,research-worker.
install_file \
  "$SCRIPT_DIR/extensions/research-worker.ts" \
  "$PI_AGENT_DIR/extensions/research-worker.ts"

# Planner worker: the `planner-worker` tool (agent-invokable, gated by --tools)
# + the `/plan "<prompt>"` command. Both spawn a jailed planner worker
# (plan-jailed.sh) that writes its plan into the research workspace. Opt
# the tool in with --tools ...,planner-worker.
install_file \
  "$SCRIPT_DIR/extensions/planner-worker.ts" \
  "$PI_AGENT_DIR/extensions/planner-worker.ts"

# Coder worker: the `coder-worker` tool (agent-invokable, gated by --tools)
# + the `/implement "<prompt>"` command. Both spawn an implementation worker
# (coder-run.sh) that WRITES THE REAL REPOSITORY (write/edit/bash, TDD). Unlike
# the read-only workers it is NOT jailed — it must run in a writable, NON-research
# session (ideally the container-harness) and refuses hard in research mode. Opt
# the tool in with --tools ...,coder-worker.
install_file \
  "$SCRIPT_DIR/extensions/coder-worker.ts" \
  "$PI_AGENT_DIR/extensions/coder-worker.ts"

# Default role: light coordinator persona + situational tool guidance for bare
# `pi` (defers to research mode / restricted sessions). Opt out: --no-default-role.
install_file \
  "$SCRIPT_DIR/extensions/default-role.ts" \
  "$PI_AGENT_DIR/extensions/default-role.ts"

# Local host override: opt-in PI_LOCAL_HOST repoints the local MLX providers
# (loopback baseUrls in the 18080-18130 band) at a non-loopback host, e.g.
# 192.168.64.1. Unset (default) is a no-op. Used by the container-harness
# --direct mode and for running the host bank off loopback.
install_file \
  "$SCRIPT_DIR/extensions/local-host-override.ts" \
  "$PI_AGENT_DIR/extensions/local-host-override.ts"

# Qwen2.5-Coder-32B tool-call repair: the dense coder on local-mlx-qwen25coder32b
# emits tool calls as text (<tools>/<tool_call>/bare JSON) that the backend
# parser drops, so pi never dispatches. This overrides that one provider's
# stream to rewrite the leaked call into a real toolCall. Strict no-op for every
# other model (scoped to the provider/model id). No-op too where the model isn't
# served (provider absent from models.json).
install_file \
  "$SCRIPT_DIR/extensions/qwen25coder-toolcall.ts" \
  "$PI_AGENT_DIR/extensions/qwen25coder-toolcall.ts"

# Research mode extension (read-only jail with isolated write workspace).
# Single self-contained extension: provides write-research + bash-safe tools,
# the /research-mode command, system-prompt injection, and tool enforcement.
install_file \
  "$SCRIPT_DIR/extensions/research-mode.ts" \
  "$PI_AGENT_DIR/extensions/research-mode.ts"

# Research mode documentation
install_file \
  "$SCRIPT_DIR/extensions/RESEARCH-MODE.md" \
  "$PI_AGENT_DIR/extensions/RESEARCH-MODE.md"

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

install_file \
  "$SCRIPT_DIR/extensions/lib/quorum-peer.ts" \
  "$PI_AGENT_DIR/extensions/lib/quorum-peer.ts"

# Clean up pre-reorg paths if present (upgrade path).
for stale in adapter-route.ts adversary-parse.ts adversary-capture.ts; do
  rm -f "$PI_AGENT_DIR/extensions/$stale"
done

echo ""
echo "=== Scripts ==="
install_file \
  "$SCRIPT_DIR/scripts/bash/adversary-check.sh" \
  "${SCRIPTS_DIR}/adversary-check.sh"
chmod +x "${SCRIPTS_DIR}/adversary-check.sh"

install_file \
  "$SCRIPT_DIR/scripts/bash/adversary-pass.sh" \
  "${SCRIPTS_DIR}/adversary-pass.sh"
chmod +x "${SCRIPTS_DIR}/adversary-pass.sh"

# Tool-enabled adversary inside the research-mode jail (read-only + bash-safe).
install_file \
  "$SCRIPT_DIR/scripts/bash/adversary-jailed.sh" \
  "${SCRIPTS_DIR}/adversary-jailed.sh"
chmod +x "${SCRIPTS_DIR}/adversary-jailed.sh"

# Tool-enabled research worker inside the research-mode jail (read-only + bash-safe).
install_file \
  "$SCRIPT_DIR/scripts/bash/research-jailed.sh" \
  "${SCRIPTS_DIR}/research-jailed.sh"
chmod +x "${SCRIPTS_DIR}/research-jailed.sh"

# Tool-enabled planner worker inside the research-mode jail (read-only + bash-safe).
install_file \
  "$SCRIPT_DIR/scripts/bash/plan-jailed.sh" \
  "${SCRIPTS_DIR}/plan-jailed.sh"
chmod +x "${SCRIPTS_DIR}/plan-jailed.sh"

# Implementation worker that WRITES THE REAL REPO (write/edit/bash, TDD). NOT a
# jail: it requires a writable, non-research session and fails hard in research
# mode.
install_file \
  "$SCRIPT_DIR/scripts/bash/coder-run.sh" \
  "${SCRIPTS_DIR}/coder-run.sh"
chmod +x "${SCRIPTS_DIR}/coder-run.sh"

install_file \
  "$SCRIPT_DIR/scripts/bash/adversary-scan.sh" \
  "${SCRIPTS_DIR}/adversary-scan.sh"
chmod +x "${SCRIPTS_DIR}/adversary-scan.sh"

install_file \
  "$SCRIPT_DIR/scripts/bash/adversary-loop.sh" \
  "${SCRIPTS_DIR}/adversary-loop.sh"
chmod +x "${SCRIPTS_DIR}/adversary-loop.sh"

install_file \
  "$SCRIPT_DIR/scripts/bash/capture-review.sh" \
  "${SCRIPTS_DIR}/capture-review.sh"
chmod +x "${SCRIPTS_DIR}/capture-review.sh"

# capture-review.sh delegates to a tsx-runnable TS file. Install it at
# $SCRIPTS_DIR/ts/ so the wrapper's first-candidate path resolves.
install_file \
  "$SCRIPT_DIR/scripts/ts/capture-review.ts" \
  "${SCRIPTS_DIR}/ts/capture-review.ts"

# drift-check.sh (Stage 1a of adversary-pass.sh) re-checks a written review for
# prose/YAML drift; it delegates to scripts/ts/drift-check.ts. Install both, or
# adversary-pass.sh's drift check silently no-ops on a global install.
install_file \
  "$SCRIPT_DIR/scripts/bash/drift-check.sh" \
  "${SCRIPTS_DIR}/drift-check.sh"
chmod +x "${SCRIPTS_DIR}/drift-check.sh"
install_file \
  "$SCRIPT_DIR/scripts/ts/drift-check.ts" \
  "${SCRIPTS_DIR}/ts/drift-check.ts"

install_file \
  "$SCRIPT_DIR/scripts/bash/gen-review-revise.sh" \
  "${SCRIPTS_DIR}/gen-review-revise.sh"
chmod +x "${SCRIPTS_DIR}/gen-review-revise.sh"

# --- Make in-repo server launchers executable (no copy; invoke from repo) ---
# mlx-server.sh and the mlx-lm-multi/mola launchers reference each other
# by SCRIPT_DIR-relative paths, so they must run from the pi-tools tree.
# Installing them under ~/.pi/agent/ would break those relative paths.
for launcher in mlx-server.sh bootstrap-mac.sh upgrade.sh; do
  [[ -f "$SCRIPT_DIR/server/$launcher" ]] && chmod +x "$SCRIPT_DIR/server/$launcher"
done
for sh in "$SCRIPT_DIR/server/mlx-lm-multi"/*.sh "$SCRIPT_DIR/server/mola"/*.sh \
          "$SCRIPT_DIR/server/thinking-adversary"/*.sh; do
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

# --- Memory-tier detection (role→model provisioning) ---
# Unified memory governs how many local-model tracks can co-reside, which
# decides the role→model map (see MODELS.md "Local model roles & memory
# tiers (RPI)"). Two CERTIFIED tiers:
#   large (>= 112 GB, 128GB-class): 27B for reasoning roles + the 32B
#     Code Worker concurrently (+ 80B as a manual single-session alternate).
#   small (< 112 GB): 27B for all roles (the 35GB 32B worker can't
#     co-reside with the resident 27B). 64GB is explicitly UNCERTIFIED and
#     falls in this conservative profile.
# 128GB Macs report 128; 112 is a safe floor below 128 and above any 64/96
# box. PI_FORCE_MEM_GB overrides detection (tests + non-Darwin hosts).
if [[ -n "${PI_FORCE_MEM_GB:-}" ]]; then
  MEM_GB="$PI_FORCE_MEM_GB"
elif [[ "$(uname -s)" == "Darwin" ]]; then
  # Fall back to 0 (→ small tier) if sysctl is unavailable (restricted
  # container, future key rename). An empty `$(sysctl …)` expansion would
  # otherwise make this `$(( / 1073741824 ))` — an arithmetic syntax error
  # that aborts the whole install under `set -e`.
  _memraw=$(sysctl -n hw.memsize 2>/dev/null || echo 0)
  MEM_GB=$(( ${_memraw:-0} / 1073741824 ))
else
  MEM_GB=0
fi
# Non-numeric (e.g. a malformed PI_FORCE_MEM_GB) → conservative small tier,
# never an aborting error in the -ge comparison below.
[[ "$MEM_GB" =~ ^[0-9]+$ ]] || MEM_GB=0
if [[ "$MEM_GB" -ge 112 ]]; then
  MEM_TIER="large"
else
  MEM_TIER="small"
fi
echo ""
# An explicit --small/--large flag wins over detection AND PI_FORCE_MEM_GB:
# override the decided tier here so the role-map logic below is untouched.
if [[ -n "$FORCE_TIER" ]]; then
  MEM_TIER="$FORCE_TIER"
  echo "=== Memory tier: ${MEM_TIER} (forced via --${FORCE_TIER}; detected ${MEM_GB} GB unified) ==="
else
  echo "=== Memory tier: ${MEM_TIER} (detected ${MEM_GB} GB unified) ==="
fi

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

# --- Provision the Code-Worker providers ---
# Additive + idempotent (re-running adds nothing, churns no backups). Two views:
#   local-mlx-coder27b  — the 27B Code-Worker view (→ :18080, same weights as
#     local-mlx, flagged thinking-controllable). It serves the Coder on the SMALL
#     tier, and is also provisioned on LARGE so a 128GB box can exercise the small
#     path via PI_CODER_TIER=small. Always available on arm64 (the 27B is up).
#   local-mlx-qwen25coder32b — the 35GB dense 32B Coder, LARGE tier only (it
#     can't co-reside with the resident 27B on a <112GB box).
if [[ "$IS_ARM64" -eq 1 ]] && [[ -f "$MODELS_JSON" ]] && [[ -f "$TEMPLATE" ]]; then
  echo ""
  echo "=== Code Worker (27B view): ensuring local-mlx-coder27b in $MODELS_JSON ==="
  rc=0
  merge_provider "$MODELS_JSON" "$TEMPLATE" "local-mlx-coder27b" || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    echo "  WARNING: coder27b provider merge failed (python3 exit $rc); inspect $MODELS_JSON manually"
  fi
  if [[ "$MEM_TIER" == "large" ]]; then
    echo "=== Code Worker (large tier): ensuring local-mlx-qwen25coder32b in $MODELS_JSON ==="
    rc=0
    merge_provider "$MODELS_JSON" "$TEMPLATE" "local-mlx-qwen25coder32b" || rc=$?
    if [[ "$rc" -ne 0 ]]; then
      echo "  WARNING: 32B provider merge failed (python3 exit $rc); inspect $MODELS_JSON manually"
    fi
  else
    echo "=== Code Worker: 32B skipped (small tier — 27B serves the Coder via local-mlx-coder27b) ==="
  fi
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
# On arm64 we set defaultProvider=local-mlx + defaultModel=~/models/Qwen3.5-27B-4bit
# (the deployed thinking-adversary model; the id is the literal model dir
# because mlx_lm.server resolves the request `model` as a path).
# We do clobber a pre-existing `ollama` default — and the older local-mlx
# default `qwen3-coder-30b-a3b` (the legacy sft base) — because those are
# exactly the wrong-default bug we're fixing. We leave any other explicit
# defaultProvider/defaultModel value alone so operators can pin a different
# target. Set PI_TOOLS_KEEP_DEFAULTS=1 to suppress the rewrite entirely.
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
# The deployed default is the thinking-adversary track (single Qwen3.5-27B
# sidecar). mlx_lm.server resolves the request `model` as a path, so the
# models.json id — and this default — is the literal model dir.
default_model = os.path.expanduser("~/models/Qwen3.5-27B-4bit")
ollama_defaults = {None, "", "ollama"}
# Overwrite the provider when it's unset/ollama OR already local-mlx (so an
# already-bootstrapped box with a stale local-mlx default gets migrated too).
provider_ok_to_overwrite = current_provider in (ollama_defaults | {"local-mlx"})
# Overwrite the model only when it's a known stale default (ollama ids or the
# legacy sft base qwen3-coder-30b-a3b). A deliberately-pinned custom model —
# under any provider — is left alone because model_ok_to_overwrite is False.
stale_model_defaults = ollama_defaults | {"qwen3-coder", "qwen3-coder:30b", "qwen3-coder-next", "qwen3-coder-30b-a3b"}
model_ok_to_overwrite = current_model in stale_model_defaults
if not (provider_ok_to_overwrite and model_ok_to_overwrite):
    print(f"  NOTE: {path} has non-ollama defaults (provider={current_provider!r}, model={current_model!r}); leaving as-is.")
    print("        Set PI_TOOLS_KEEP_DEFAULTS=1 to silence; delete the keys to force overwrite.")
    sys.exit(2)
if existed:
    backup = f"{path}.bak.{int(time.time())}"
    shutil.copy2(path, backup)
    print(f"  Backup: {backup}")
data["defaultProvider"] = "local-mlx"
data["defaultModel"] = default_model
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
print(f"  Set: defaultProvider=local-mlx, defaultModel={default_model}")
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
echo " Memory tier: ${MEM_TIER} (${MEM_GB} GB unified)"
if [[ "$MEM_TIER" == "large" ]]; then
  echo "   Role → model map (RPI), 128GB-class:"
  echo "     Session / Adversary / Researcher / Planner → Qwen3.5-27B-4bit (local-mlx, :18080)"
  echo "     Code Worker / Implementor                  → Qwen2.5-Coder-32B-Instruct-8bit (local-mlx-qwen25coder32b, :18111)"
  echo "     27B + 32B co-reside; the 80B (local-mlx-80b, :18130) is a MANUAL single-session"
  echo "     alternate — one heavy track at a time, spawns no parallel agents."
else
  echo "   Role → model map (conservative / <128GB-class, 64GB uncertified):"
  echo "     27B for all roles (small-context); the 32B Code Worker is NOT provisioned"
  echo "     (it can't co-reside with the resident 27B)."
fi
echo "   Full table + doctrine: MODELS.md \"Local model roles & memory tiers (RPI)\"."
echo ""
echo " Invocation paths:"
echo ""
echo "   /adversary-review          # self-review checklist (prompt command)"
echo "   /adversary-pass <file>     # jailed adversary review of a file (add --quorum for peers)"
echo "   /research \"<prompt>\"        # dispatch a jailed research worker to do a task"
echo "   /plan \"<prompt>\"            # dispatch a jailed planner worker to produce a plan"
echo "   /implement \"<prompt>\"       # dispatch a TDD coder worker that WRITES the real repo (writable/non-research session only)"
echo "   /skill:adversary           # full adversary review"
echo "   /skill:manager             # manager coordination session"
echo "   /skill:orchestrator        # orchestrator session"
echo "   /skill:worker              # worker implementation session"
echo "   /skill:research            # research and analysis (use with research-mode extension)"
echo "   /skill:rpi                 # RPI coordinator: drive research→plan→implement, adversary-gated"
echo ""
echo "   ${SCRIPTS_DIR}/adversary-pass.sh <file>          # headless adversary pipeline"
echo "   ${SCRIPTS_DIR}/adversary-pass.sh <file> --quorum # with manual quorum"
echo "   ${SCRIPTS_DIR}/gen-review-revise.sh <spec.md>    # full generate→review→revise"
echo ""
echo "   (Add ${SCRIPTS_DIR} to PATH in your shell rc to invoke by bare name.)"
echo ""
echo " Server stack control (run from the pi-tools checkout):"
echo "   bash $SCRIPT_DIR/server/mlx-server.sh up      # Qwen + extras"
echo "   bash $SCRIPT_DIR/server/mlx-server.sh status  # listeners + health"
echo "   bash $SCRIPT_DIR/server/mlx-server.sh list    # configured tracks"
echo "   See $SCRIPT_DIR/server/extra-models/README.md to add a contrast model."
echo ""
echo " Extensions active in all pi sessions:"
echo "   adversary-hook.ts     (mechanical check after every write/edit)"
echo "   quorum.ts             (auto-quorum on CONCERNS/FAIL verdicts; peers run jailed read-only)"
echo "   adversary-review.ts   (/adversary-pass <file> command; adversary-review tool when in --tools)"
echo "   research-worker.ts    (/research \"<prompt>\" command; research-worker tool when in --tools)"
echo "   planner-worker.ts     (/plan \"<prompt>\" command; planner-worker tool when in --tools)"
echo "   coder-worker.ts       (/implement \"<prompt>\" command; coder-worker tool when in --tools — WRITES the real repo, writable/non-research session only)"
echo "   qwen25coder-toolcall.ts (repairs Qwen2.5-Coder-32B leaked tool calls; no-op for other models)"
echo ""
echo " Research mode (read-only jail) — research-mode.ts, auto-discovered:"
echo "   Strongest (harness-level) invocation:"
echo "     pi --tools read,grep,find,ls,write-research,bash-safe"
echo "     Then type: /research-mode   (sets up workspace + jails the agent)"
echo ""
echo "   write-research and bash-safe MUST be in --tools — pi's allowlist drops"
echo "   any tool not listed, and the extension cannot restore it at runtime."
echo ""
echo "   Add adversary-review / research-worker / planner-worker to let the agent self-invoke a jailed"
echo "   reviewer, dispatch a jailed research worker, or dispatch a jailed planner worker:"
echo "     pi --tools read,grep,find,ls,write-research,bash-safe,adversary-review,research-worker,planner-worker --research"
echo "   (the /adversary-pass <file>, /research \"<prompt>\", and /plan \"<prompt>\" commands"
echo "    are always available regardless of --tools.)"
echo ""
echo "   /research-mode also works without --tools (it deactivates write/edit/bash"
echo "   itself and warns), and one-shot/print runs can auto-activate with --research:"
echo "     pi --tools read,grep,find,ls,write-research,bash-safe --research -p 'Analyze'"
echo ""
echo "   PI_RESEARCH_WORKSPACE=/path persists/resumes a workspace across sessions"
echo "   (also auto-activates research mode at startup)."
echo ""
echo "   See ~/.pi/agent/extensions/RESEARCH-MODE.md for full documentation."
echo ""
echo "   Use /skill:research for research-mode sessions (grounded, evidence-based analysis)."
echo ""
echo " qwen3-coder note:"
echo "   Non-thinking mode only — no <think> blocks."
echo "   Step-by-step structure in skill prompts is the reasoning scaffold."
echo ""
echo " To verify:"
echo "   pi /adversary-review"
echo "   pi /skill:adversary"
echo ""
