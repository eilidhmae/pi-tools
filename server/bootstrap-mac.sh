#!/usr/bin/env bash
# bootstrap-mac.sh — one-shot M5 Max setup for the pi-tools adapter pipeline.
# Idempotent. Re-runs are safe; existing artifacts are not re-downloaded.

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
BASE_MODEL_REPO="mlx-community/Qwen3-Coder-7B-Instruct-4bit"
BASE_MODEL_DIR="$MODELS_DIR/qwen3-coder-7b-4bit"
LLAMA_CPP_DIR="${LLAMA_CPP_DIR:-$HOME/src/llama.cpp}"

say()   { printf "\033[1;36m==>\033[0m %s\n" "$*"; }
warn()  { printf "\033[1;33m!! \033[0m %s\n" "$*" >&2; }
fail()  { printf "\033[1;31mxx \033[0m %s\n" "$*" >&2; exit 1; }

# 1. Homebrew baseline
if ! command -v brew >/dev/null 2>&1; then
    fail "Homebrew not found. Install from https://brew.sh first."
fi

say "Installing Homebrew dependencies (uv, gh, jq, cmake)…"
brew list --formula uv      >/dev/null 2>&1 || brew install uv
brew list --formula gh      >/dev/null 2>&1 || brew install gh
brew list --formula jq      >/dev/null 2>&1 || brew install jq
brew list --formula cmake   >/dev/null 2>&1 || brew install cmake

# 2. Python env (uv-managed) for mlx-lm and friends
PY_ENV="$HOME/.pi/agent/venv"
if [[ ! -d "$PY_ENV" ]]; then
    say "Creating Python venv at $PY_ENV"
    uv venv "$PY_ENV" --python 3.12
fi
# shellcheck disable=SC1091
source "$PY_ENV/bin/activate"

say "Installing mlx-lm, huggingface_hub, fastapi, uvicorn…"
uv pip install --upgrade \
    'mlx-lm>=0.20.0' \
    'huggingface_hub[cli]>=0.24' \
    'fastapi>=0.110' \
    'uvicorn>=0.30' \
    'pyyaml>=6.0' \
    'packaging>=23.0'

# 3. macOS + MLX sanity check.
#
# Apple Neural Accelerator support for M5 lands in macOS Tahoe 26.2 paired
# with a recent mlx-lm. The mlx PACKAGE itself is on 0.x — its version
# string does not encode neural-accelerator support — so we check the macOS
# version (which does) and the mlx import (which must succeed) separately.
MLX_VERSION="$(python -c 'import mlx; print(mlx.__version__)')"
say "MLX library version: $MLX_VERSION  (informational; mlx is on 0.x)"

MACOS_VERSION="$(sw_vers -productVersion 2>/dev/null || echo 0.0)"
say "macOS version: $MACOS_VERSION"
if ! MAC_VER="$MACOS_VERSION" python - <<'PY'
import os, sys
mac_ver = os.environ["MAC_VER"]
try:
    from packaging.version import Version, InvalidVersion
except ImportError:
    sys.exit(0)  # packaging not installed; skip warn
try:
    if Version(mac_ver) >= Version("26.2"):
        sys.exit(0)
    sys.exit(1)
except InvalidVersion as e:
    print(f"!! macOS version '{mac_ver}' not PEP 440 ({e}); skipping check", file=sys.stderr)
    sys.exit(0)
PY
then
    warn "macOS $MACOS_VERSION < 26.2 — Apple Neural Accelerators on M5"
    warn "may fall back to GPU shader cores. Update macOS for full performance."
fi

# 4. Base model
mkdir -p "$MODELS_DIR"
if [[ ! -d "$BASE_MODEL_DIR" || -z "$(ls -A "$BASE_MODEL_DIR" 2>/dev/null)" ]]; then
    say "Downloading base model $BASE_MODEL_REPO → $BASE_MODEL_DIR"
    huggingface-cli download "$BASE_MODEL_REPO" --local-dir "$BASE_MODEL_DIR"
else
    say "Base model already present at $BASE_MODEL_DIR"
fi

# 5. llama.cpp for GGUF conversion (release builds only)
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

# 6. pi binary check
if ! command -v pi >/dev/null 2>&1; then
    warn "pi CLI not found on PATH. Install pi-coding-agent before using the harness."
fi

# 7. models.json
PI_AGENT_DIR="$HOME/.pi/agent"
mkdir -p "$PI_AGENT_DIR"
if [[ ! -f "$PI_AGENT_DIR/models.json" ]]; then
    say "Installing models.json template → $PI_AGENT_DIR/models.json"
    cp "$(dirname "$0")/models.json.template" "$PI_AGENT_DIR/models.json"
else
    warn "$PI_AGENT_DIR/models.json already exists; not overwriting."
    warn "Diff against $(dirname "$0")/models.json.template if you want the new local-mlx provider."
fi

# 8. Adapters dir
mkdir -p "$HOME/models/adapters"

cat <<'BANNER'

================================================================================
Bootstrap complete.

Next:
  1. Pull a released adapter (dogfood — never use raw training output):
       gh release download worker-go-v1 \
         -R eilidhmae/pi-adapter-worker-go \
         -p 'adapter-mlx.safetensors' -p 'adapter_config.json' \
         -D ~/models/adapters/worker-go/

  2. Configure server/mlx-lm-multi/adapters.conf with one line per adapter:
       worker-go         8081  ~/models/adapters/worker-go

  3. Launch the default inference track:
       ./mlx-lm-multi/launch.sh

  4. Sanity check:
       curl -sS http://localhost:8080/healthz | jq .
       curl -sS http://localhost:8080/v1/models | jq .

  5. Use it:
       pi --provider local-mlx --model qwen3-coder-7b+go "your task"

See ../MODELS.md for the full operator guide.
================================================================================
BANNER
