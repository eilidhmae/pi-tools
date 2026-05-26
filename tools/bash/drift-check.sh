#!/usr/bin/env bash
# drift-check.sh -- Thin wrapper that runs tools/ts/drift-check.ts.
#
# Same resolver pattern as capture-review.sh: tsx (preferred), then
# npx --no-install tsx, then ts-node, then a network npx -y tsx.
#
# Usage:
#   drift-check.sh --review <path.md>
#
# Re-parses the review file's YAML block and appends a
# `## Pipeline Drift Warning` block when a prose section that should
# reference a YAML finding (per the category→section mapping in
# skills/adversary/SKILL.md) still uses "no issues" boilerplate.
#
# Informational only — never edits the prose or YAML in place, never
# changes the verdict. Always exits 0 unless the TS CLI itself errored.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TS_FILE=""
for candidate in \
  "$SCRIPT_DIR/ts/drift-check.ts" \
  "$SCRIPT_DIR/../ts/drift-check.ts" \
  "$HOME/.pi/agent/tools/ts/drift-check.ts"; do
  if [[ -f "$candidate" ]]; then
    TS_FILE="$candidate"
    break
  fi
done
if [[ -z "$TS_FILE" ]]; then
  echo "ERROR: drift-check.ts not found (looked in:" >&2
  echo "  $SCRIPT_DIR/ts/, $SCRIPT_DIR/../ts/, ~/.pi/agent/tools/ts/)" >&2
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
