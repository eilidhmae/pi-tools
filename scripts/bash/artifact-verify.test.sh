#!/usr/bin/env bash
# Tests for artifact-verify.sh on the host (needs node for checksum.sh).
# Run: bash scripts/bash/artifact-verify.test.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=/dev/null
source ./artifact-verify.sh

fails=0
check() { # got want label
  if [[ "$1" == "$2" ]]; then echo "  ok - $3"; else echo "  FAIL - $3 (got '$1' want '$2')"; fails=$((fails + 1)); fi
}

# av_substantive
av_substantive "short text" && r=yes || r=no
check "$r" "no" "short input → not substantive"
big="$(printf 'x%.0s' $(seq 1 300))"
av_substantive "$big" && r=yes || r=no
check "$r" "yes" "300 chars → substantive"
av_substantive "tiny" 2 && r=yes || r=no
check "$r" "yes" "custom min_chars honoured"

tmp="$(mktemp -d)"

# av_write_verified happy path
WANT="$(av_write_verified "hello world this is the intended content" "$tmp/r.md")"; rc=$?
check "$rc" "0" "good write → returns 0"
check "$(cat "$tmp/r.md")" "hello world this is the intended content" "file holds exactly the intended bytes"
check "$WANT" "$(bash ./checksum.sh --file "$tmp/r.md")" "printed digest == a fresh hash of the file"

# av_write_verified to an unwritable target (parent dir absent) → escalate (1)
av_write_verified "content" "$tmp/nodir/r.md" >/dev/null; rc=$?
check "$rc" "1" "unwritable target → returns 1 (escalate, no phantom success)"

rm -rf "$tmp"
echo
if [[ "$fails" -eq 0 ]]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
