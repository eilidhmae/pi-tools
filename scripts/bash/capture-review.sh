#!/usr/bin/env bash
# capture-review.sh -- Thin wrapper that runs scripts/ts/capture-review.ts.
#
# Resolves tsx (preferred), then ts-node, then falls back to npx tsx.
# Same pattern as extensions/__tests__/run.sh — keeps the harness
# usable on a fresh machine, accepts a one-off network fetch.
#
# Usage:
#   capture-review.sh --review <path.md> --scope <scope>
#                      [--model <id>] [--temperature <n>]
#                      [--artifact-path <p>] [--git-sha <sha>]
#
# Always exits 0 unless the CLI itself errored. Capture is
# informational — it must not block adversary review.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# install.sh places the TS source at $TOOLS_DIR/ts/, sibling to this
# wrapper, for both global (~/.pi/agent/scripts/ts/) and local
# (<repo>/scripts/bash/ts/) layouts. Repo-tree development uses ../ts/
# from scripts/bash/ since the source lives at scripts/ts/.
TS_FILE=""
for candidate in \
  "$SCRIPT_DIR/ts/capture-review.ts" \
  "$SCRIPT_DIR/../ts/capture-review.ts" \
  "$HOME/.pi/agent/scripts/ts/capture-review.ts"; do
  if [[ -f "$candidate" ]]; then
    TS_FILE="$candidate"
    break
  fi
done
if [[ -z "$TS_FILE" ]]; then
  echo "ERROR: capture-review.ts not found (looked in:" >&2
  echo "  $SCRIPT_DIR/ts/, $SCRIPT_DIR/../ts/, ~/.pi/agent/scripts/ts/)" >&2
  exit 1
fi

if command -v tsx >/dev/null 2>&1; then
  exec tsx "$TS_FILE" "$@"
fi

if npx --no-install tsx --version >/dev/null 2>&1; then
  exec npx --no-install tsx "$TS_FILE" "$@"
fi

if command -v ts-node >/dev/null 2>&1; then
  exec ts-node --transpile-only "$TS_FILE" "$@"
fi

# Last resort: pull tsx from the registry. Requires network on first run.
exec npx -y tsx "$TS_FILE" "$@"
