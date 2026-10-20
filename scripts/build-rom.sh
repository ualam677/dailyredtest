#!/usr/bin/env bash
# Builds the Daily Red ROM (pokeemerald-expansion's FireRed build) with the
# project-local toolchain (see scripts/setup-macos.sh) and puts a gzipped copy
# in web/game/ for the website.
#
#   scripts/build-rom.sh            # normal build (the first one takes a while)
#   scripts/build-rom.sh clean      # any extra args are passed to make
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TC="$ROOT/.toolchain"
GAME="$ROOT/expansion"

if [ -x "$TC/arm-none-eabi/bin/arm-none-eabi-gcc" ]; then
  export PATH="$TC/arm-none-eabi/bin:$PATH"
elif ! command -v arm-none-eabi-gcc >/dev/null; then
  echo "Toolchain missing. Run scripts/setup-macos.sh first."; exit 1
fi
if [ ! -d "$GAME" ]; then
  echo "expansion/ is missing. Run scripts/get-expansion.sh first."; exit 1
fi

# The tool Makefiles ask pkg-config for libpng; clang and gcc also honour these
# variables, which lets them find our static libpng without pkg-config/Homebrew.
if [ -f "$TC/libpng/lib/libpng.a" ]; then
  export CPATH="$TC/libpng/include${CPATH:+:$CPATH}"
  export LIBRARY_PATH="$TC/libpng/lib${LIBRARY_PATH:+:$LIBRARY_PATH}"
  # A no-op pkg-config so the tool Makefiles don't print "command not found".
  export PATH="$ROOT/scripts/shims:$PATH"
fi

JOBS="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

# BUILD=firered picks the FireRed build for every target (`make firered` only
# does for that one goal).
if [ "$#" -gt 0 ]; then
  make -C "$GAME" BUILD=firered -j"$JOBS" "$@"
  exit 0
fi

make -C "$GAME" BUILD=firered -j"$JOBS"

ROM="$GAME/pokefirered.gba"
# The website downloads a gzipped copy (32 MB -> ~18 MB, much of it 0xFF
# padding) and unpacks it in the browser.
mkdir -p "$ROOT/web/game"
rm -f "$ROOT/web/game/dailyred.gba"
gzip -9 -n -c "$ROM" > "$ROOT/web/game/dailyred.gba.gz"
# RED's battle sprite for the site's title card (from the decomp, like the ROM).
cp "$GAME/graphics/trainers/front_pics/red.png" "$ROOT/web/game/red.png"
echo
echo "Built $ROM"
echo "Website copy: web/game/dailyred.gba.gz ($(wc -c < "$ROOT/web/game/dailyred.gba.gz" | tr -d ' ') bytes)"
