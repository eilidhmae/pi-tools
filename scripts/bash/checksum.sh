#!/usr/bin/env bash
# checksum.sh -- bash front-end to extensions/lib/checksum-cli.ts (our own
# SHA-256; no system hash binary, portable BSD<->GNU, jail-safe).
#
# Passes its arguments straight through to the CLI and preserves its exit code:
#   0 = match / digest printed   1 = mismatch   2 = IO or usage error
#
# Runner resolution: node's built-in TS stripping first (offline, no extra
# dependency), then tsx, then npx tsx — same fallback shape as capture-review.sh
# / drift-check.sh.
#
# Usage (see checksum-cli.ts for the full flag set):
#   checksum.sh --file <path>
#   checksum.sh --value-stdin
#   checksum.sh --file <path> --expect <hexdigest>
#   checksum.sh --file <path> --against-env <NAME>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TS_FILE=""
for candidate in \
  "$HOME/.pi/agent/extensions/lib/checksum-cli.ts" \
  "$SCRIPT_DIR/../../extensions/lib/checksum-cli.ts"; do
  if [[ -f "$candidate" ]]; then
    TS_FILE="$candidate"
    break
  fi
done
if [[ -z "$TS_FILE" ]]; then
  echo "ERROR: checksum-cli.ts not found (run install.sh)." >&2
  exit 2
fi

# Node's own TS stripping (Node >= 22.6) — no extra dep, works offline.
if command -v node >/dev/null 2>&1 \
   && node --experimental-strip-types -e 'process.exit(0)' >/dev/null 2>&1; then
  exec node --experimental-strip-types "$TS_FILE" "$@"
fi

if command -v tsx >/dev/null 2>&1; then
  exec tsx "$TS_FILE" "$@"
fi

if npx --no-install tsx --version >/dev/null 2>&1; then
  exec npx --no-install tsx "$TS_FILE" "$@"
fi

# Last resort: pull tsx from the registry (needs network on first run).
exec npx -y tsx "$TS_FILE" "$@"
