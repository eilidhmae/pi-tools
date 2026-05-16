#!/usr/bin/env bash
#
# install.sh -- Point this clone's git hooks at pi-tools/hooks.
# Idempotent: safe to run multiple times.

set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

chmod +x hooks/pre-commit
chmod +x hooks/post-commit
chmod +x hooks/pre-push
git config core.hooksPath hooks

echo "core.hooksPath = $(git config --get core.hooksPath)"
echo "Pre-commit hook installed.  Bypass with: git commit --no-verify"
echo "Post-commit hook installed. Non-blocking adversary scan for corpus"
echo "                            capture; bypass with PI_SKIP_POST_COMMIT_SCAN=1"
echo "                            or [skip scan] in the commit message."
echo "Pre-push hook installed.    Mandatory adversary FAIL gate; no bypass."
