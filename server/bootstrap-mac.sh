#!/usr/bin/env bash
# bootstrap-mac.sh — Apple Silicon setup for the pi-tools inference pipeline.
# Idempotent. Re-runs are safe; existing artifacts are not re-downloaded.
#
# What this does:
#   1. Installs uv / gh / jq via Homebrew (if missing).
#   2. Creates the venv at $HOME/.pi/agent/venv (python 3.12).
#   3. Clones mlx-lm, merges two open upstream PRs onto main, and installs
#      the patched build editable into the venv. The two PRs are required
#      for the pi-tools adversary pipeline:
#        - PR #1277 (eilidhmae:fix-think-state-user-content) — bounds the
#          <think> scan to the assistant prefill tail, so user messages
#          containing literal <think> don't route all output to
#          message.reasoning.
#        - PR #1249  (odysa:fix/adapter-path) — fixes --adapter-path being
#          silently ignored at mlx_lm.server startup.
#   4. Installs the rest of the Python deps (fastapi, uvicorn, hf_hub, etc.).
#   5. Downloads the Qwen3-Coder-30B-A3B-Instruct-4bit base model
#      (~16 GB) into $HOME/models/.
#   6. Verifies pi binary and models.json.
#
# What this no longer does (compared to the M5 Max bootstrap on main):
#   - No llama.cpp clone / build. That path was only needed for GGUF
#     conversion (publishing adapters as Ollama-loadable artifacts);
#     consumers of pi-tools don't need it.
#   - No cmake brew install (was only required to build llama.cpp).

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "This script targets macOS on Apple Silicon. Detected: $(uname -s)" >&2
    exit 1
fi
if [[ "$(uname -m)" != "arm64" ]]; then
    echo "Apple Silicon required (uname -m == arm64). Detected: $(uname -m)" >&2
    exit 1
fi

MODELS_DIR="${MODELS_DIR:-$HOME/models}"
BASE_MODEL_REPO="mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit"
BASE_MODEL_DIR="$MODELS_DIR/Qwen3-Coder-30B-A3B-Instruct-4bit"
MLX_LM_DIR="${MLX_LM_DIR:-$HOME/src/mlx-lm}"
MLX_LM_REPO="${MLX_LM_REPO:-https://github.com/ml-explore/mlx-lm.git}"
PATCHED_BRANCH="pi-tools-patched"

say()   { printf "\033[1;36m==>\033[0m %s\n" "$*"; }
warn()  { printf "\033[1;33m!! \033[0m %s\n" "$*" >&2; }
fail()  { printf "\033[1;31mxx \033[0m %s\n" "$*" >&2; exit 1; }

# --- Memory advisory ---
# Hosts under 64 GB unified memory have to operate base-only (each
# adapter/contrast process spawns its own full copy of the 4-bit base
# model at ~16 GB resident). Surface this early so operators don't get
# surprised when they uncomment a second adapter row and the box swaps.
RAM_GB=$(( $(sysctl -n hw.memsize) / 1024 / 1024 / 1024 ))
say "Detected $RAM_GB GB unified memory."
if (( RAM_GB < 64 )); then
    warn "32 GB-class host. Recommended profile:"
    warn "  - adapters.conf: leave empty (each row adds ~16 GB resident)"
    warn "  - extra-models/config.conf: leave empty (same reason)"
    warn "  - quorum: fine (sequential HTTP, no extra processes)"
    warn "  - mola track: experimental — base shared in-process, lower"
    warn "    memory ceiling than mlx-lm-multi but flagged alpha in"
    warn "    server/HEALTH.md"
fi

# 1. Homebrew baseline
if ! command -v brew >/dev/null 2>&1; then
    fail "Homebrew not found. Install from https://brew.sh first."
fi

say "Installing Homebrew dependencies (uv, gh, jq)…"
brew list --formula uv      >/dev/null 2>&1 || brew install uv
brew list --formula gh      >/dev/null 2>&1 || brew install gh
brew list --formula jq      >/dev/null 2>&1 || brew install jq

# 2. Python env (uv-managed)
PY_ENV="$HOME/.pi/agent/venv"
if [[ ! -d "$PY_ENV" ]]; then
    say "Creating Python venv at $PY_ENV"
    uv venv "$PY_ENV" --python 3.12
fi
# shellcheck disable=SC1091
source "$PY_ENV/bin/activate"

# 3. Patched mlx-lm (PRs #1277 + #1249)
say "Preparing patched mlx-lm at $MLX_LM_DIR"
if [[ ! -d "$MLX_LM_DIR/.git" ]]; then
    git clone "$MLX_LM_REPO" "$MLX_LM_DIR"
fi

(
    cd "$MLX_LM_DIR"

    # Make sure we have the latest main + the two PR refs.
    git fetch --quiet origin main
    # Force-update the local refs so reruns don't trip on non-fast-forward
    # PR updates.
    git fetch --quiet origin "+refs/pull/1277/head:refs/heads/pr-1277" || \
        fail "could not fetch PR #1277; check network and gh.com access"
    git fetch --quiet origin "+refs/pull/1249/head:refs/heads/pr-1249" || \
        fail "could not fetch PR #1249; check network and gh.com access"

    # Recreate the patched branch from scratch each run so reruns stay
    # idempotent and any local edits get discarded. If you need to pin
    # to a specific mlx-lm main SHA, export MLX_LM_BASE_REF.
    MLX_LM_BASE_REF="${MLX_LM_BASE_REF:-origin/main}"

    # Detach so we can safely delete branches we might be on.
    git checkout --quiet --detach
    git branch -D "$PATCHED_BRANCH" >/dev/null 2>&1 || true
    git checkout --quiet -b "$PATCHED_BRANCH" "$MLX_LM_BASE_REF"

    # Merge each PR. If a merge conflicts the user has to resolve it
    # manually; we fail loudly rather than auto-resolving the wrong way.
    if ! git merge --no-ff --no-edit -m "merge PR #1249 fix/adapter-path" pr-1249; then
        warn "Merge conflict applying PR #1249 onto $MLX_LM_BASE_REF."
        warn "Resolve in $MLX_LM_DIR and rerun bootstrap-mac.sh."
        exit 3
    fi
    if ! git merge --no-ff --no-edit -m "merge PR #1277 fix-think-state-user-content" pr-1277; then
        warn "Merge conflict applying PR #1277 onto $PATCHED_BRANCH."
        warn "Resolve in $MLX_LM_DIR and rerun bootstrap-mac.sh."
        exit 3
    fi

    say "Installing patched mlx-lm editable into $PY_ENV"
    uv pip install --python "$PY_ENV/bin/python" -e .
)

# Sanity check: confirm mlx_lm imports from the patched checkout, not pypi.
RESOLVED="$(python -c 'import mlx_lm, pathlib; print(pathlib.Path(mlx_lm.__file__).resolve().parent)')"
EXPECTED="$MLX_LM_DIR/mlx_lm"
if [[ "$RESOLVED" != "$EXPECTED" ]]; then
    warn "mlx_lm resolves to: $RESOLVED"
    warn "Expected:           $EXPECTED"
    warn "mlx-server.sh's PI_EXPECTED_MLX_PATH check will fail until this matches."
else
    say "mlx_lm patched build verified: $RESOLVED"
fi
echo "export PI_EXPECTED_MLX_PATH=\"$EXPECTED\"   # paste into your shell rc to enable mlx-server.sh patch-check"

# 4. Other Python deps mlx-lm doesn't pull on its own.
say "Installing supporting Python deps (huggingface_hub, fastapi, uvicorn, …)"
uv pip install --upgrade \
    'huggingface_hub>=0.34' \
    'fastapi>=0.110' \
    'uvicorn>=0.30' \
    'watchfiles>=0.20' \
    'pyyaml>=6.0' \
    'packaging>=23.0'

# 5. macOS + MLX sanity check.
#
# macOS Tahoe 26.2 is the baseline this pipeline is tested against on M5.
# On M2/M2 Max the ANE story is moot (no ANE-aware mlx-lm release yet);
# the 26.2 floor is forward-looking.
MLX_VERSION="$(python -c 'from importlib.metadata import version; print(version("mlx"))')"
say "MLX library version: $MLX_VERSION  (informational; mlx is on 0.x)"

MACOS_VERSION="$(sw_vers -productVersion 2>/dev/null || echo 0.0)"
say "macOS version: $MACOS_VERSION"
if ! MAC_VER="$MACOS_VERSION" python - <<'PY'
import os, sys
mac_ver = os.environ["MAC_VER"]
try:
    from packaging.version import Version, InvalidVersion
except ImportError:
    sys.exit(0)
try:
    if Version(mac_ver) >= Version("26.2"):
        sys.exit(0)
    sys.exit(1)
except InvalidVersion as e:
    print(f"!! macOS version '{mac_ver}' not PEP 440 ({e}); skipping check", file=sys.stderr)
    sys.exit(0)
PY
then
    warn "macOS $MACOS_VERSION is below the tested baseline of 26.2."
    warn "Inference will still run on Metal/GPU; consider updating to stay"
    warn "on the supported floor for future MLX releases."
fi

# 6. Base model
mkdir -p "$MODELS_DIR"
if [[ ! -d "$BASE_MODEL_DIR" || -z "$(ls -A "$BASE_MODEL_DIR" 2>/dev/null)" ]]; then
    say "Downloading base model $BASE_MODEL_REPO → $BASE_MODEL_DIR (~16 GB)"
    hf download "$BASE_MODEL_REPO" --local-dir "$BASE_MODEL_DIR"
else
    say "Base model already present at $BASE_MODEL_DIR"
fi

# 7. pi binary check
if ! command -v pi >/dev/null 2>&1; then
    warn "pi CLI not found on PATH. Install pi-coding-agent before using the harness."
fi

# 8. models.json
PI_AGENT_DIR="$HOME/.pi/agent"
mkdir -p "$PI_AGENT_DIR"
if [[ ! -f "$PI_AGENT_DIR/models.json" ]]; then
    say "Installing models.json template → $PI_AGENT_DIR/models.json"
    cp "$(dirname "$0")/models.json.template" "$PI_AGENT_DIR/models.json"
else
    warn "$PI_AGENT_DIR/models.json already exists; not overwriting."
    warn "Diff against $(dirname "$0")/models.json.template if you want the new local-mlx provider."
fi

# 9. Adapters dir (consumed by adapters.conf rows when you add any)
mkdir -p "$HOME/models/adapters"

cat <<BANNER

================================================================================
Bootstrap complete.

  Patched mlx-lm: $MLX_LM_DIR  (branch: $PATCHED_BRANCH)
  Base model:     $BASE_MODEL_DIR
  Venv:           $PY_ENV

Next:
  1. Bring up the inference stack:
       bash $(cd "$(dirname "$0")" && pwd)/mlx-server.sh up

  2. Sanity check:
       curl -sS http://localhost:18080/healthz | jq .
       curl -sS http://localhost:18080/v1/models | jq .

  3. Use it:
       pi --provider local-mlx --model qwen3-coder-30b-a3b "your task"

  Optional: pull an adapter and add it to mlx-lm-multi/adapters.conf
  (each enabled row adds ~16 GB resident; on 32 GB hosts, run at most one).

See ../MODELS.md for the full operator guide.
================================================================================
BANNER
