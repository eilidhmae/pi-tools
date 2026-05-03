#!/usr/bin/env bash
# launch.sh — start the MOLA multi-LoRA server on :8080.
# Reads the same adapters.conf as the default track for adapter listing.
#
# Venv isolation: MOLA's install patches mlx-lm in-place. We use a separate
# venv ($HOME/.pi/agent/venv-mola by default) so the shared mlx-lm-multi
# venv stays unmodified. Override with PY_ENV if you really mean to share.
#
# This is alpha; see ../HEALTH.md for fallback procedure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHARED_CONF="$SCRIPT_DIR/../mlx-lm-multi/adapters.conf"
PIDS_DIR="$SCRIPT_DIR/pids"
LOG_DIR="$SCRIPT_DIR/logs"
MOLA_DIR="${MOLA_DIR:-$HOME/src/mola}"
MOLA_REPO="${MOLA_REPO:-https://github.com/Goekdeniz-Guelmez/mlx-lm-mola}"
BASE_MODEL_DIR="${BASE_MODEL_DIR:-$HOME/models/qwen3-coder-7b-4bit}"
PORT="${PROXY_PORT:-8080}"
# Isolated venv — the MOLA install patches mlx-lm in-place; do NOT share with
# the mlx-lm-multi venv.
PY_ENV="${PY_ENV:-$HOME/.pi/agent/venv-mola}"

mkdir -p "$PIDS_DIR" "$LOG_DIR"

# Create the isolated mola venv on first run. Sentinel file marks
# successful completion of the install step — re-runs that find the
# directory but no sentinel will retry the install rather than
# silently activating a half-populated venv.
SENTINEL="$PY_ENV/.install-complete"
if [[ ! -f "$SENTINEL" ]]; then
    if [[ -d "$PY_ENV" ]]; then
        echo "==> mola venv exists at $PY_ENV but install was incomplete; reinstalling"
    else
        echo "==> creating isolated mola venv at $PY_ENV"
        uv venv "$PY_ENV" --python 3.12
    fi
    # shellcheck disable=SC1091
    source "$PY_ENV/bin/activate"
    uv pip install --upgrade \
        'mlx-lm>=0.20.0' \
        'huggingface_hub[cli]>=0.24' \
        'fastapi>=0.110' \
        'uvicorn>=0.30' \
        'pyyaml>=6.0' \
        'packaging>=23.0'
    : > "$SENTINEL"
else
    # shellcheck disable=SC1091
    source "$PY_ENV/bin/activate"
fi

if [[ ! -d "$MOLA_DIR/.git" ]]; then
    echo "==> cloning MOLA → $MOLA_DIR"
    git clone --depth 1 "$MOLA_REPO" "$MOLA_DIR"
    pushd "$MOLA_DIR" >/dev/null
    if [[ -f patches/mlx-lm.patch ]]; then
        echo "==> applying mlx-lm patch (inside isolated venv $PY_ENV)"
        # User must verify this patch path against upstream before relying on it.
        ( cd "$(python -c 'import mlx_lm, os; print(os.path.dirname(mlx_lm.__file__))')" \
          && patch -p1 < "$MOLA_DIR/patches/mlx-lm.patch" ) || {
            echo "!! patch failed — review $MOLA_DIR/patches/mlx-lm.patch and apply manually" >&2
            exit 1
          }
    fi
    pip install -e . >/dev/null
    popd >/dev/null
fi

# Build adapter list from the shared conf
ADAPTER_ARGS=()
if [[ -f "$SHARED_CONF" ]]; then
    while IFS= read -r line; do
        line="${line%%#*}"
        line="$(echo "$line" | xargs || true)"
        [[ -z "$line" ]] && continue
        # shellcheck disable=SC2206
        cols=( $line )
        [[ ${#cols[@]} -ne 3 ]] && continue
        suffix="${cols[0]}"
        adapter_path="${cols[2]/#\~/$HOME}"
        [[ -d "$adapter_path" ]] || continue
        ADAPTER_ARGS+=( --adapter "$suffix=$adapter_path" )
    done < "$SHARED_CONF"
fi

echo "==> mola   port=$PORT  base=$BASE_MODEL_DIR"
echo "    adapters: ${ADAPTER_ARGS[*]:-(none)}"

nohup python -m mola.server \
    --model "$BASE_MODEL_DIR" \
    --port "$PORT" \
    --host 127.0.0.1 \
    "${ADAPTER_ARGS[@]}" \
    >"$LOG_DIR/mola.log" 2>&1 &
echo $! > "$PIDS_DIR/mola.pid"

sleep 1
echo "Logs:    $LOG_DIR"
echo "Health:  curl -sS http://localhost:$PORT/healthz | jq ."
