#!/usr/bin/env bash
# Saves every change made inside expansion/ (edited and new files) to
# patches/expansion-dailyred.patch. Run it after editing the game, and commit
# the patch: expansion/ itself isn't tracked by this repository.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GAME="$ROOT/expansion"

# Mark new files as "intent to add" so they appear in the diff (ignored build
# outputs stay out, thanks to the expansion's own .gitignore), then unmark them.
git -C "$GAME" add --intent-to-add .
git -C "$GAME" diff --binary HEAD > "$ROOT/patches/expansion-dailyred.patch"
git -C "$GAME" diff --stat HEAD | tail -1
git -C "$GAME" reset -q
echo "Saved patches/expansion-dailyred.patch"
