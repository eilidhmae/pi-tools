#!/usr/bin/env bash
#
# adversary-scan.sh -- Scope-inferring wrapper around adversary-pass.sh.
#
# Usage:
#   adversary-scan.sh                         # review `git diff HEAD`
#   adversary-scan.sh --staged                # review `git diff --cached`
#   adversary-scan.sh --range origin..HEAD    # review a commit range
#   adversary-scan.sh path/to/file.go         # review one file
#   adversary-scan.sh path/to/dir/            # walk dir, review every
#                                             # source file individually
#
# Options:
#   --staged             Review the index (`git diff --cached`).
#                        Pre-commit-hook semantics.
#   --range <A..B>       Review the diff over a commit range. Pre-push
#                        hook semantics: `--range origin/$BRANCH..HEAD`.
#   --gate               Convert verdict to exit code:
#                          0 = PASS, 0 = CONCERNS (warn-only),
#                          1 = FAIL  (any FAIL aborts).
#                        Without --gate the script is informational and
#                        always exits 0, matching adversary-check.sh.
#   --jobs <N>           Reserved for parallelism. Currently ignored;
#                        all reviews run serially per the Phase 0
#                        decision (`mlx_lm.server` decodes serially —
#                        spawning N adversary-pass.sh processes against
#                        one backend gives queue depth, not parallelism;
#                        true parallelism needs N backend processes,
#                        which is a Phase 2+ concern).
#   --provider <name>    Pi provider id (default: ollama).
#   --model <id>         Pi model id (default: qwen3-coder:30b).
#   --adapter / --domain Same shorthands as adversary-pass.sh.
#
# Scope rules:
#   - No positional, no --staged, no --range:
#       Default scope = working-tree changes (HEAD). Fails with a clear
#       error if the working tree is clean — that's the caller's signal
#       to either edit something or pass an explicit path / range.
#   - Positional path:
#       File   → one review (delegate to adversary-pass.sh <file>).
#       Dir    → enumerate source files under the dir (allowlist below),
#                run adversary-pass.sh per file. One v1 record per file.
#                Skips vendored/generated trees (.git, node_modules,
#                vendor, target, dist, build) and common config / lock
#                files.
#
# Output:
#   Per-file or per-scope reviews land in ./reviews/ (relative to CWD)
#   via adversary-pass.sh. The scan itself prints a roll-up summary at
#   the end with one line per reviewed unit and the final aggregate
#   verdict (FAIL > CONCERNS > PASS, worst-wins).
#
# Always exits 0 unless --gate is set and the aggregate verdict is FAIL.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS_SH="$SCRIPT_DIR/adversary-pass.sh"
if [[ ! -x "$PASS_SH" ]]; then
  # Fall back to global install if not next to scan.sh.
  PASS_SH="$HOME/.pi/agent/tools/adversary-pass.sh"
fi
if [[ ! -x "$PASS_SH" ]]; then
  echo "ERROR: adversary-pass.sh not found alongside scan.sh or under" >&2
  echo "       ~/.pi/agent/tools/. Run install.sh first." >&2
  exit 1
fi

# --- Argument parsing ---
STAGED=0
RANGE=""
GATE=0
JOBS=1
PASS_THRU=()  # extra args to forward to adversary-pass.sh
POSITIONAL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --staged)              STAGED=1 ;;
    --range)               RANGE="${2:?--range requires A..B}"; shift ;;
    --gate)                GATE=1 ;;
    --jobs)                JOBS="${2:-1}"; shift ;;
    --provider|--model)    PASS_THRU+=("$1" "$2"); shift ;;
    --adapter)             PASS_THRU+=("$1") ;;
    --domain)              PASS_THRU+=("$1" "$2"); shift ;;
    --)                    shift; break ;;
    --*)                   echo "Unknown option: $1" >&2; exit 1 ;;
    *)
      if [[ -n "$POSITIONAL" ]]; then
        echo "ERROR: extra positional argument: $1" >&2
        echo "       Pass a single file or directory; use --range/--staged for diffs." >&2
        exit 1
      fi
      POSITIONAL="$1" ;;
  esac
  shift
done

# Mutual exclusion guard.
modes=0
[[ -n "$POSITIONAL" ]] && modes=$((modes + 1))
[[ "$STAGED" -eq 1 ]] && modes=$((modes + 1))
[[ -n "$RANGE" ]] && modes=$((modes + 1))
if [[ "$modes" -gt 1 ]]; then
  echo "ERROR: pass at most one of: positional path, --staged, --range A..B" >&2
  exit 1
fi

if [[ "$JOBS" -ne 1 ]]; then
  echo "NOTE: --jobs $JOBS requested but parallelism is not implemented." >&2
  echo "      Reviews will run serially. See header comment for why." >&2
fi

# --- Resolve the scan plan ---
# A "unit" is one invocation of adversary-pass.sh. Multi-file dirs
# produce N units; everything else produces 1.
UNITS=()    # array of target tokens passed positionally to pass.sh

if [[ -n "$POSITIONAL" ]]; then
  if [[ -f "$POSITIONAL" ]]; then
    UNITS+=("$POSITIONAL")
  elif [[ -d "$POSITIONAL" ]]; then
    # Source-file allowlist. Conservative; expand as need surfaces.
    EXTENSIONS=(go py js jsx ts tsx rs c h cc cpp hpp java kt swift rb php scala)
    # Build a find -name expression. Skip vendored/generated trees.
    FIND_NAME=()
    for ext in "${EXTENSIONS[@]}"; do
      [[ ${#FIND_NAME[@]} -gt 0 ]] && FIND_NAME+=("-o")
      FIND_NAME+=("-name" "*.${ext}")
    done
    # Read into UNITS one path per line. -print0 / null delimiter would
    # be safer for paths with newlines, but newline-in-path is rare
    # enough in source trees that the simpler -print is fine here.
    while IFS= read -r f; do
      [[ -n "$f" ]] && UNITS+=("$f")
    done < <(find "$POSITIONAL" \
      \( -name .git -o -name node_modules -o -name vendor \
         -o -name target -o -name dist -o -name build \) -prune \
      -o -type f \( "${FIND_NAME[@]}" \) -print | sort)
    if [[ ${#UNITS[@]} -eq 0 ]]; then
      echo "ERROR: no source files under $POSITIONAL (extensions: ${EXTENSIONS[*]})" >&2
      exit 1
    fi
  else
    echo "ERROR: '$POSITIONAL' is neither a file nor a directory." >&2
    exit 1
  fi
elif [[ "$STAGED" -eq 1 ]]; then
  UNITS+=("STAGED")
elif [[ -n "$RANGE" ]]; then
  if [[ "$RANGE" != *..* ]]; then
    echo "ERROR: --range must be of form A..B (got '$RANGE')" >&2
    exit 1
  fi
  UNITS+=("RANGE:$RANGE")
else
  # Default: working tree vs HEAD.
  if ! git rev-parse --is-inside-work-tree &>/dev/null; then
    echo "ERROR: no positional path given, and CWD is not a git repo." >&2
    echo "       Pass a file, a directory, or run from inside a git repo." >&2
    exit 1
  fi
  if [[ -z "$(git diff HEAD)" ]]; then
    echo "ERROR: working tree is clean. Pass a file path, a directory," >&2
    echo "       --staged for the index, or --range A..B for a commit" >&2
    echo "       range. There is no default scope when nothing has" >&2
    echo "       changed." >&2
    exit 1
  fi
  UNITS+=("HEAD")
fi

echo "================================================"
echo "  ADVERSARY SCAN"
echo "  Units:  ${#UNITS[@]}"
echo "  Gate:   $([[ $GATE -eq 1 ]] && echo on || echo off)"
echo "================================================"
echo ""

# --- Iterate units, collecting verdicts ---
WORST_VERDICT="PASS"
PASS_COUNT=0
CONCERNS_COUNT=0
FAIL_COUNT=0
UNKNOWN_COUNT=0
SUMMARY_LINES=()

# Worst-wins rank.
verdict_rank() {
  case "$1" in
    PASS)     echo 0 ;;
    CONCERNS) echo 1 ;;
    FAIL)     echo 2 ;;
    *)        echo -1 ;;
  esac
}

idx=0
for unit in "${UNITS[@]}"; do
  idx=$((idx + 1))
  echo "--- [${idx}/${#UNITS[@]}] $unit ---"
  # adversary-pass.sh always exits 0; verdict is in its stdout.
  if [[ ${#PASS_THRU[@]} -eq 0 ]]; then
    OUT=$("$PASS_SH" "$unit" 2>&1)
  else
    OUT=$("$PASS_SH" "$unit" "${PASS_THRU[@]}" 2>&1)
  fi
  echo "$OUT"
  V=$(echo "$OUT" | grep -E '^Verdict:' | head -1 | awk '{print $2}')
  V="${V:-UNKNOWN}"
  case "$V" in
    PASS)     PASS_COUNT=$((PASS_COUNT + 1)) ;;
    CONCERNS) CONCERNS_COUNT=$((CONCERNS_COUNT + 1)) ;;
    FAIL)     FAIL_COUNT=$((FAIL_COUNT + 1)) ;;
    *)        UNKNOWN_COUNT=$((UNKNOWN_COUNT + 1)) ;;
  esac
  SUMMARY_LINES+=("  ${V}  ${unit}")
  if [[ $(verdict_rank "$V") -gt $(verdict_rank "$WORST_VERDICT") ]]; then
    WORST_VERDICT="$V"
  fi
done

echo ""
echo "================================================"
echo "  SCAN SUMMARY"
echo "================================================"
for line in "${SUMMARY_LINES[@]}"; do
  echo "$line"
done
echo ""
echo "  PASS:     $PASS_COUNT"
echo "  CONCERNS: $CONCERNS_COUNT"
echo "  FAIL:     $FAIL_COUNT"
echo "  UNKNOWN:  $UNKNOWN_COUNT"
echo ""
echo "  Aggregate verdict: $WORST_VERDICT"
echo "================================================"

# --- Exit code ---
if [[ "$GATE" -eq 1 ]]; then
  case "$WORST_VERDICT" in
    PASS|CONCERNS) exit 0 ;;
    FAIL)          exit 1 ;;
    *)             exit 2 ;;  # UNKNOWN — distinct from FAIL so callers can tell
  esac
fi
exit 0
