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
#   5. Downloads the primary thinking-adversary model (Qwen3.5-27B, ~17 GB)
#      flat into $HOME/models/Qwen3.5-27B-4bit, sets/persists HF_HOME=$HOME/models,
#      and (only with --with-sft) the legacy Qwen3-Coder-30B-A3B base.
#   6. Verifies pi binary and models.json.
#
# Models and HF cache live under $HOME/models (HF_HOME). The primary model is
# downloaded with --local-dir so it is a FLAT directory with a top-level
# config.json — mlx_lm.server loads a path, and a bare HF cache tree
# (blobs/refs/snapshots, no top-level config.json) makes it hang on first
# request. Override the models root with MODELS_DIR=...
#
# What's gated by host memory:
#   - llama.cpp clone/build + cmake are producer-only (the GGUF
#     publishing pipeline — model-plan.md: convert_hf_to_gguf.py +
#     llama-quantize). Built on >=64 GB hosts (M5 Max), skipped on
#     <64 GB (M2 Max consumer). Override with --with-llama-cpp /
#     --no-llama-cpp. Everything else runs on every Apple Silicon host.

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

# All HuggingFace models/cache live under $MODELS_DIR (~/models by default).
# Export for this run so `hf download` and repo-id resolution use it, and
# persist it to the operator's shell rc below (see persist_hf_home). The
# primary model download uses --local-dir, which is independent of HF_HOME,
# but everything else (cache, repo-id loads) honours it.
export HF_HOME="${HF_HOME:-$MODELS_DIR}"

# Primary model: the deployed thinking-adversary base (Qwen3.5-27B, zero-shot).
# Downloaded flat into $MODELS_DIR so the top level has config.json — what
# mlx_lm.server needs. (A bare `hf download` cache tree has no top-level
# config.json and makes the server hang on first request.)
THINKING_MODEL_REPO="${THINKING_MODEL_REPO:-Jackrong/Qwen3.5-27B-Claude-4.6-Opus-Reasoning-Distilled}"
THINKING_MODEL_DIR="$MODELS_DIR/Qwen3.5-27B-4bit"

# Legacy sft track base (Qwen3-Coder-30B-A3B + LoRA adapters). Only downloaded
# when --with-sft is passed; the default install serves the thinking track only.
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
    warn "  - adapters.conf: at most 1 row enabled. Measured per-process"
    warn "    resident on M2 Max: ~11 GB at idle (grows with KV cache)."
    warn "    Base + 1 adapter ≈ 22 GB resident; 2+ adapters will swap."
    warn "  - extra-models/config.conf: leave empty (each row is another"
    warn "    independent ~11 GB process)."
    warn "  - quorum: fine (sequential HTTP, no extra processes)."
    warn "  - mola track: experimental — base shared in-process, lower"
    warn "    memory ceiling than mlx-lm-multi but flagged alpha in"
    warn "    server/HEALTH.md."
fi

# --- llama.cpp build gate ---
# llama.cpp + cmake are only needed by the M5-only GGUF publishing
# pipeline (model-plan.md: convert_hf_to_gguf.py + llama-quantize, the
# Metal build). Consumers don't publish adapters, so gate the
# multi-minute build by host memory:
#   - >=64 GB host (M5 Max / producer): default ON  (== bootstrap on main).
#   - <64 GB host  (M2 Max / consumer): default OFF (skip the build).
# Override with --with-llama-cpp / --no-llama-cpp.
if (( RAM_GB >= 64 )); then
    WITH_LLAMA_CPP=1
else
    WITH_LLAMA_CPP=0
fi
# Legacy sft track (Qwen3-Coder-30B-A3B + adapters) is opt-in: the default
# install serves only the thinking-adversary track. Pass --with-sft to also
# download the ~16 GB Qwen3-Coder base.
WITH_SFT=0
for arg in "$@"; do
    case "$arg" in
        --with-llama-cpp) WITH_LLAMA_CPP=1 ;;
        --no-llama-cpp)   WITH_LLAMA_CPP=0 ;;
        --with-sft)       WITH_SFT=1 ;;
    esac
done
LLAMA_CPP_DIR="${LLAMA_CPP_DIR:-$HOME/src/llama.cpp}"

# 1. Homebrew baseline
if ! command -v brew >/dev/null 2>&1; then
    fail "Homebrew not found. Install from https://brew.sh first."
fi

if [[ "$WITH_LLAMA_CPP" -eq 1 ]]; then
    say "Installing Homebrew dependencies (uv, gh, jq, cmake)…"
else
    say "Installing Homebrew dependencies (uv, gh, jq)…"
fi
brew list --formula uv      >/dev/null 2>&1 || brew install uv
brew list --formula gh      >/dev/null 2>&1 || brew install gh
brew list --formula jq      >/dev/null 2>&1 || brew install jq
if [[ "$WITH_LLAMA_CPP" -eq 1 ]]; then
    brew list --formula cmake >/dev/null 2>&1 || brew install cmake
fi

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

    # --- Preflight guard: never destructive-revert a working dev checkout. ---
    # The recreate below (detach; branch -D pi-tools-patched; checkout -b
    # pi-tools-patched origin/main; merge PRs) discards uncommitted work and
    # detaches an active feature branch. On the M5 Max $MLX_LM_DIR is a live
    # dev checkout (e.g. branch fix-think-state-user-content with uncommitted
    # mlx_lm/server.py). Skip the recreate when the tree is dirty; the existing
    # editable venv install is left in place and the import sanity check below
    # still runs (it passes when the venv is already patched). A fresh clone
    # (M2 box) is clean, so the recreate runs there as normal.
    #
    # `git diff --quiet` exits non-zero when dirty; the `|| TREE_DIRTY=1` form
    # captures that without `set -e` aborting the script.
    TREE_DIRTY=0
    git diff --quiet          || TREE_DIRTY=1
    git diff --cached --quiet || TREE_DIRTY=1
    CUR_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo DETACHED)"

    if [[ "$TREE_DIRTY" -eq 1 ]]; then
        warn "mlx-lm checkout at $MLX_LM_DIR is on '$CUR_BRANCH' with a dirty"
        warn "working tree. SKIPPING the patched-branch recreate to protect"
        warn "uncommitted work; assuming the venv is already patched (the"
        warn "sanity check below confirms). To force a clean rebuild: commit/"
        warn "stash your changes, or set MLX_LM_DIR to a throwaway path."
    else
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
    fi

    say "Installing patched mlx-lm editable into $PY_ENV"
    uv pip install --python "$PY_ENV/bin/python" -e .
)

# Sanity check: confirm mlx_lm imports from the patched checkout, not pypi.
RESOLVED="$(python -c 'import mlx_lm, pathlib; print(pathlib.Path(mlx_lm.__file__).resolve().parent)')"
EXPECTED="$MLX_LM_DIR/mlx_lm"
# Actual checked-out branch for the banner: on the dirty-tree skip path this is
# the operator's dev branch (e.g. fix-think-state-user-content), not the
# recreated pi-tools-patched branch.
MLX_LM_BRANCH="$(git -C "$MLX_LM_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "$PATCHED_BRANCH")"
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

# 6. Models
mkdir -p "$MODELS_DIR"

# 6a. Primary: thinking-adversary base (the deployed default). Flat --local-dir
# download so the top level has config.json (mlx_lm.server loads a path, not a
# cache tree).
if [[ ! -d "$THINKING_MODEL_DIR" || -z "$(ls -A "$THINKING_MODEL_DIR" 2>/dev/null)" ]]; then
    say "Downloading thinking model $THINKING_MODEL_REPO → $THINKING_MODEL_DIR (~17 GB)"
    hf download "$THINKING_MODEL_REPO" --local-dir "$THINKING_MODEL_DIR"
else
    say "Thinking model already present at $THINKING_MODEL_DIR"
fi
if [[ ! -f "$THINKING_MODEL_DIR/config.json" ]]; then
    warn "$THINKING_MODEL_DIR has no top-level config.json — mlx_lm.server will"
    warn "hang on first request. Re-download flat:"
    warn "  hf download $THINKING_MODEL_REPO --local-dir $THINKING_MODEL_DIR"
fi

# 6b. Legacy sft base (Qwen3-Coder-30B-A3B + adapters), opt-in via --with-sft.
if [[ "$WITH_SFT" -eq 1 ]]; then
    if [[ ! -d "$BASE_MODEL_DIR" || -z "$(ls -A "$BASE_MODEL_DIR" 2>/dev/null)" ]]; then
        say "Downloading sft base $BASE_MODEL_REPO → $BASE_MODEL_DIR (~16 GB)"
        hf download "$BASE_MODEL_REPO" --local-dir "$BASE_MODEL_DIR"
    else
        say "sft base already present at $BASE_MODEL_DIR"
    fi
else
    say "Skipping sft base download (thinking track is the default; --with-sft to add it)."
fi

# 6c. Persist HF_HOME=$MODELS_DIR to the operator's shell rc (idempotent).
persist_hf_home() {
    local rc
    case "${SHELL:-/bin/zsh}" in
        *zsh)  rc="$HOME/.zshrc" ;;
        *bash) rc="$HOME/.bashrc" ;;
        *)     rc="$HOME/.zshrc" ;;
    esac
    if [[ -f "$rc" ]] && grep -q 'HF_HOME=' "$rc"; then
        say "HF_HOME already set in $rc (leaving as-is)"
        return 0
    fi
    {
        echo ""
        echo "# pi-tools: keep all HuggingFace models/cache under $MODELS_DIR"
        echo "export HF_HOME=\"$MODELS_DIR\""
    } >> "$rc"
    say "Persisted HF_HOME=$MODELS_DIR to $rc (open a new shell or 'source $rc')"
}
persist_hf_home

# 6d. llama.cpp for GGUF conversion (producer-only).
# The M5 GGUF publishing pipeline (model-plan.md steps 4-6:
# convert_hf_to_gguf.py + llama-quantize) needs the Metal build. Gated by
# WITH_LLAMA_CPP (default ON >=64 GB; --no-llama-cpp to skip). When
# skipped, mlx_lm inference is unaffected.
if [[ "$WITH_LLAMA_CPP" -eq 1 ]]; then
    if [[ ! -d "$LLAMA_CPP_DIR/.git" ]]; then
        say "Cloning llama.cpp → $LLAMA_CPP_DIR"
        git clone --depth 1 https://github.com/ggerganov/llama.cpp "$LLAMA_CPP_DIR"
    else
        say "llama.cpp present; pulling latest"
        git -C "$LLAMA_CPP_DIR" pull --ff-only || warn "git pull failed, continuing"
    fi

    if [[ ! -x "$LLAMA_CPP_DIR/build/bin/llama-quantize" ]]; then
        say "Building llama.cpp (Metal)…"
        cmake -S "$LLAMA_CPP_DIR" -B "$LLAMA_CPP_DIR/build" -DGGML_METAL=ON -DGGML_NATIVE=ON >/dev/null
        cmake --build "$LLAMA_CPP_DIR/build" --config Release -j >/dev/null
    fi
else
    say "Skipping llama.cpp build (consumer profile; --with-llama-cpp to enable)."
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

  Patched mlx-lm: $MLX_LM_DIR  (branch: $MLX_LM_BRANCH)
  Thinking model: $THINKING_MODEL_DIR
  HF_HOME:        $HF_HOME
  Venv:           $PY_ENV

Next:
  1. Bring up the inference stack (thinking-adversary track is the default):
       bash $(cd "$(dirname "$0")" && pwd)/mlx-server.sh up thinking

  2. Sanity check:
       curl -sS http://localhost:18080/healthz | jq .
       curl -sS http://localhost:18080/v1/models | jq .

  3. Use it (uses the thinking model default from settings.json):
       pi -p "Reply with one word: ready"

  Legacy sft track (Qwen3-Coder-30B-A3B + LoRA adapters) is opt-in: re-run
  with --with-sft to download its base, then `mlx-server.sh up sft`.

See ../MODELS.md for the full operator guide and
../docs/ONBOARDING-APPLE-SILICON.md for a fresh-machine walkthrough.
================================================================================
BANNER
