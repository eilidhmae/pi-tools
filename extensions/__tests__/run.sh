#!/usr/bin/env bash
# Tiny standalone runner for the adversary-parse tests.
#
# Tries tsx (preferred), then ts-node, then falls back to a thin
# transpile-via-typescript step. Run from the repo root:
#   bash extensions/__tests__/run.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TEST_FILE="$HERE/adversary-parse.test.ts"

if command -v tsx >/dev/null 2>&1; then
  exec tsx "$TEST_FILE"
fi

if npx --no-install tsx --version >/dev/null 2>&1; then
  exec npx --no-install tsx "$TEST_FILE"
fi

if command -v ts-node >/dev/null 2>&1; then
  exec ts-node --transpile-only "$TEST_FILE"
fi

# Last resort: pull tsx from the registry. Requires network.
exec npx -y tsx "$TEST_FILE"
