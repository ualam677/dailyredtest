#!/usr/bin/env bash
# Recreates expansion/ from a clean checkout: fetches rh-hideout/pokeemerald-expansion
# at the pinned release (it builds FireRed with `make firered`) and applies the
# Daily Red changes from patches/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GAME="$ROOT/expansion"
PATCH="$ROOT/patches/expansion-dailyred.patch"
URL="https://github.com/rh-hideout/pokeemerald-expansion.git"
RELEASE="expansion/1.17.1"
COMMIT="bb1093a7c72d3961d9a37d8e02ad2abc2c866682"

if [ -e "$GAME" ]; then
  echo "expansion/ already exists. Delete it first to start from a fresh copy."
  exit 1
fi

git init -q "$GAME"
git -C "$GAME" remote add origin "$URL"
echo ">> Fetching pokeemerald-expansion $RELEASE (${COMMIT:0:10})"
git -C "$GAME" fetch -q --depth 1 origin "$COMMIT"
git -C "$GAME" checkout -q FETCH_HEAD
echo ">> Applying $(basename "$PATCH")"
git -C "$GAME" apply --whitespace=nowarn "$PATCH"
echo "Done. Build with: scripts/build-rom.sh"
