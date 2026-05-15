#!/usr/bin/env bash
#
# install.sh -- Point this clone's git hooks at pi-tools/hooks.
# Idempotent: safe to run multiple times.

set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

chmod +x hooks/pre-commit
chmod +x hooks/pre-push
git config core.hooksPath hooks

echo "core.hooksPath = $(git config --get core.hooksPath)"
echo "Pre-commit hook installed. Bypass with: git commit --no-verify"
echo "Pre-push hook installed.   Mandatory adversary FAIL gate; no bypass."
