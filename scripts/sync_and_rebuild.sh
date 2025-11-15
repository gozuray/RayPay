#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(git rev-parse --show-toplevel)"
cd "$REPO_DIR"

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "Remote 'origin' is not configured. Please add it before running this script." >&2
  exit 1
fi

echo "Fetching latest main from origin..."
git fetch origin main

echo "Resetting current branch to origin/main..."
git reset --hard origin/main

echo "Cleaning untracked files and directories..."
git clean -fd -e scripts -e scripts/

if [ -f backend/package.json ]; then
  echo "Reinstalling backend dependencies..."
  pushd backend >/dev/null
  npm install --no-progress
  popd >/dev/null
else
  echo "No backend/package.json found; skipping backend install." >&2
fi

echo "Workspace synchronization complete."
