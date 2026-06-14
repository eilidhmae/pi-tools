#!/usr/bin/env bash
# artifact-verify.sh -- shared write-verification helpers for the RPI jailed
# runners (research-jailed.sh, plan-jailed.sh). SOURCED, not executed.
#
# The contract (decided with the Architect): the runner owns only the cheap,
# deterministic part. It checks that the worker produced substantive output and
# that the file it writes lands with exactly the intended bytes (via our own
# SHA-256, checksum.sh) — retrying the WRITE only, never the worker. Anything
# else (no output, persistent write failure) escalates to the session agent,
# which decides whether to re-run or fix a blocker first.
#
# Functions:
#   av_substantive <text> [min_chars]
#       0 if <text> has >= min_chars non-whitespace chars, else 1.
#       min_chars defaults to ${PI_WORKER_MIN_CHARS:-200}.
#   av_write_verified <content> <file> [retry_limit]
#       Write <content> to <file> and checksum-verify it landed exactly,
#       retrying the WRITE up to retry_limit (default ${PI_WORKER_RETRY_LIMIT:-1}).
#       On success prints the verified sha256 and returns 0.
#       Returns 1 if the write never verified; 2 if the checksum tool could not
#       run at all (cannot compute the intended digest). The caller escalates on
#       any non-zero.
#
# -e safe: every fallible command is guarded, so sourcing into a `set -e` runner
# never aborts it on an expected failure.

_AV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_AV_CHECKSUM_SH="${HOME}/.pi/agent/scripts/checksum.sh"
[[ -f "$_AV_CHECKSUM_SH" ]] || _AV_CHECKSUM_SH="${_AV_DIR}/checksum.sh"

av_substantive() {
  local text="$1" min="${2:-${PI_WORKER_MIN_CHARS:-200}}"
  local nonws
  nonws="$(printf '%s' "$text" | tr -d '[:space:]')" || true
  [[ "${#nonws}" -ge "$min" ]]
}

av_write_verified() {
  local content="$1" file="$2" limit="${3:-${PI_WORKER_RETRY_LIMIT:-1}}"
  local want attempt=0
  want="$(printf '%s' "$content" | bash "$_AV_CHECKSUM_SH" --value-stdin 2>/dev/null)" || want=""
  if [[ -z "$want" ]]; then
    return 2  # could not compute the intended digest (checksum tool unavailable)
  fi
  while true; do
    printf '%s' "$content" > "$file" 2>/dev/null || true
    if bash "$_AV_CHECKSUM_SH" --file "$file" --expect "$want" >/dev/null 2>&1; then
      printf '%s' "$want"
      return 0
    fi
    if [[ "$attempt" -ge "$limit" ]]; then
      return 1
    fi
    attempt=$((attempt + 1))
  done
}
