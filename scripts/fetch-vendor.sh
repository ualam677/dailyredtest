#!/usr/bin/env bash
# Downloads the website's third-party files into web/vendor/ so the site is
# fully self-hosted (no CDN at runtime). Versions and checksums are pinned;
# each file has a mirror, and whichever URL answers must match the checksum.
#
#   - Nostalgist.js (MIT): small JS API around RetroArch's Emscripten build
#   - mGBA libretro core compiled to WebAssembly (GPL-3.0 / MPL-2.0),
#     from https://github.com/arianrhodsandlot/retroarch-emscripten-build
#   - Pixelify Sans, latin subset (SIL Open Font License 1.1). Optional: if no
#     URL works the site falls back to the system font.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$ROOT/web/vendor"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

NOSTALGIST_VER="0.22.0"
NOSTALGIST_SHA="e0bb4a7c0adefd4399034c4931dcc13720ff87aaedd6e1f20d88db3564da5876"
CORE_REL="v1.22.2"
CORE_SHA="d195371c3ea626c9246e9d3ab82ded4d93f3f99f85634af1588724cc44d47644"
CORE_PATH="arianrhodsandlot/retroarch-emscripten-build@$CORE_REL/retroarch/mgba_libretro.zip"
FONT_SHA="0f2216c1b7bf13b775e7b825c15e1c8414f3899cbd4120f275cdc96001a053a0"
FONT_URL="https://fonts.gstatic.com/s/pixelifysans/v3/CHylV-3HFUT7aC4iv1TxGDR9Jn0Ei0tSaJ0.woff2"
FONT_LICENSE_URL="https://raw.githubusercontent.com/google/fonts/main/ofl/pixelifysans/OFL.txt"

sha256() {
  if command -v shasum >/dev/null; then shasum -a 256 "$1" | awk '{print $1}'; else sha256sum "$1" | awk '{print $1}'; fi
}

# fetch <dest> <sha256> <url> [url...]: the first URL that downloads a file
# with the right checksum wins.
fetch() {
  local dest="$1" sha="$2"
  shift 2
  for url in "$@"; do
    if curl -fsSL --retry 2 -o "$dest" "$url" 2>/dev/null; then
      [ "$(sha256 "$dest")" = "$sha" ] && return 0
      echo "   checksum mismatch from $url"
    else
      echo "   couldn't download $url"
    fi
  done
  rm -f "$dest"
  return 1
}

mkdir -p "$VENDOR"

echo ">> Nostalgist $NOSTALGIST_VER"
fetch "$TMP/nostalgist.tgz" "$NOSTALGIST_SHA" \
  "https://registry.npmjs.org/nostalgist/-/nostalgist-$NOSTALGIST_VER.tgz" \
  || { echo "Couldn't get Nostalgist."; exit 1; }
tar -xzf "$TMP/nostalgist.tgz" -C "$TMP"
cp "$TMP/package/dist/nostalgist.js" "$VENDOR/nostalgist.js"
cp "$TMP/package/license" "$VENDOR/nostalgist.LICENSE.txt"

echo ">> mGBA core ($CORE_REL)"
fetch "$TMP/mgba.zip" "$CORE_SHA" \
  "https://cdn.jsdelivr.net/gh/$CORE_PATH" \
  "https://raw.githubusercontent.com/${CORE_PATH/@//}" \
  || { echo "Couldn't get the mGBA core."; exit 1; }
unzip -oq "$TMP/mgba.zip" -d "$VENDOR"

echo ">> Pixelify Sans"
if fetch "$TMP/font.woff2" "$FONT_SHA" "$FONT_URL"; then
  cp "$TMP/font.woff2" "$VENDOR/pixelify-sans.woff2"
  curl -fsSL -o "$VENDOR/pixelify-sans.OFL.txt" "$FONT_LICENSE_URL" || true
else
  echo "   Skipped: the site will use the system font instead."
fi

ls -la "$VENDOR"
