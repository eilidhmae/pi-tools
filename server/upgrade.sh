#!/usr/bin/env bash
#
# upgrade.sh — update an existing pi-tools install from the main branch.
#
# Idempotent and non-destructive: it pulls the latest pi-tools, refreshes the
# patched mlx-lm + venv (re-running bootstrap-mac.sh, which recreates the venv
# if it was deleted and skips already-present model downloads), re-runs the
# installer in MERGE mode (so ~/.pi/agent/models.json and settings.json are
# merged + backed up, never clobbered), verifies the patched build, restarts
# the thinking-adversary server, and smoke-checks it.
#
# Usage:
#   bash server/upgrade.sh                # pull main, refresh, restart, verify
#   bash server/upgrade.sh --with-sft     # also refresh the legacy sft base
#   PI_TOOLS_UPGRADE_BRANCH=foo \
#       bash server/upgrade.sh            # pull a branch other than main
#
# Respects existing ~/.pi: install.sh runs WITHOUT --force, so user-set
# defaults and providers are preserved (it backs up before merging).
#
# What it intentionally does NOT do: it never stashes, resets, or checks out
# your working tree. If the pi-tools checkout is dirty, it stops and asks you
# to commit or stash manually.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BOOTSTRAP="$SCRIPT_DIR/bootstrap-mac.sh"
MLX_SERVER="$SCRIPT_DIR/mlx-server.sh"
INSTALL="$REPO_DIR/install.sh"
UPGRADE_BRANCH="${PI_TOOLS_UPGRADE_BRANCH:-main}"
PORT="${PORT:-18080}"

say()  { printf "\033[1;36m==>\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m!! \033[0m %s\n" "$*" >&2; }
fail() { printf "\033[1;31mxx \033[0m %s\n" "$*" >&2; exit 1; }

# Forward bootstrap-relevant flags (e.g. --with-sft, --with-llama-cpp).
# Expanded at the call site with the ${arr[@]+...} guard: under `set -u`,
# bash < 4.4 (macOS ships 3.2) treats "${EMPTY[@]}" as an unbound variable and
# aborts. The guard yields nothing when no flags were passed, and the flags
# (quoted, one word each) when they were.
BOOTSTRAP_ARGS=("$@")

[[ -f "$BOOTSTRAP" ]] || fail "bootstrap-mac.sh not found at $BOOTSTRAP"
[[ -f "$INSTALL" ]]   || fail "install.sh not found at $INSTALL"

# 1. Pull latest pi-tools from the target branch (fast-forward only).
say "Updating pi-tools checkout at $REPO_DIR"
cd "$REPO_DIR"
if [[ -n "$(git status --porcelain)" ]]; then
    fail "working tree is dirty. Commit or stash your changes, then re-run.
       (upgrade.sh will not touch your working tree.)"
fi
CUR_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$CUR_BRANCH" != "$UPGRADE_BRANCH" ]]; then
    warn "on branch '$CUR_BRANCH', not '$UPGRADE_BRANCH'."
    warn "upgrade.sh tracks '$UPGRADE_BRANCH'. Switch with:  git checkout $UPGRADE_BRANCH"
    warn "or set PI_TOOLS_UPGRADE_BRANCH=$CUR_BRANCH to pull this branch instead."
    fail "refusing to pull a different branch into '$CUR_BRANCH'."
fi
git fetch --quiet origin "$UPGRADE_BRANCH"
git pull --ff-only origin "$UPGRADE_BRANCH"

# 2. Refresh the patched mlx-lm + venv (+ models). Idempotent: recreates the
#    venv if missing, skips already-present downloads, preserves a dirty mlx-lm
#    checkout (bootstrap's own guard).
say "Refreshing inference stack (bootstrap-mac.sh)"
bash "$BOOTSTRAP" ${BOOTSTRAP_ARGS[@]+"${BOOTSTRAP_ARGS[@]}"}

# 3. Refresh installed harness files WITHOUT clobbering user settings.
say "Re-running installer (merge mode — preserves models.json / settings.json)"
bash "$INSTALL"

# 4. Verify the patched build is the one that imports.
PY_ENV="${PY_ENV:-$HOME/.pi/agent/venv}"
MLX_LM_DIR="${MLX_LM_DIR:-$HOME/src/mlx-lm}"
if [[ -x "$PY_ENV/bin/python" ]]; then
    RESOLVED="$("$PY_ENV/bin/python" -c 'import mlx_lm, pathlib; print(pathlib.Path(mlx_lm.__file__).resolve().parent)' 2>/dev/null || echo "")"
    if [[ "$RESOLVED" == "$MLX_LM_DIR/mlx_lm" ]]; then
        say "Patched mlx-lm verified: $RESOLVED"
    else
        warn "mlx_lm resolves to '$RESOLVED', expected '$MLX_LM_DIR/mlx_lm'."
        warn "The server may be running stock mlx-lm. Inspect bootstrap output above."
    fi
else
    warn "venv python missing at $PY_ENV/bin/python; bootstrap should have created it."
fi

# 5. Restart the thinking-adversary server.
say "Restarting thinking-adversary server"
bash "$MLX_SERVER" down thinking >/dev/null 2>&1 || true
bash "$MLX_SERVER" up thinking

# 6. Smoke check. /v1/models is instant; a completion triggers the (slow) first
#    model load, so we allow time and only warn on timeout.
say "Smoke check on :$PORT"
if curl -sS -m 10 "http://127.0.0.1:$PORT/v1/models" >/dev/null 2>&1; then
    say "/v1/models responding."
else
    warn "/v1/models not responding yet; the server may still be starting."
fi
say "Done. Verify a real generation with:  pi -p 'Reply with one word: ready'"
