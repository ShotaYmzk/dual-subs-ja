#!/bin/bash
# Builds the Chrome Web Store package. Run from anywhere: bash release/build.sh
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=prime-subs-ja
VER=$(python3 -c "import json;print(json.load(open('$SRC/manifest.json'))['version'])")
OUT="release/dual-subs-ja-$VER.zip"
rm -f "$OUT"
( cd "$SRC" && zip -qr "../$OUT" manifest.json NOTICE.txt \
    background.js content.js hook.js offscreen.js offscreen.html store.js ttml.js \
    options.html options.js onboarding.html onboarding.js popup.html popup.js ui.css ui.js \
    _locales icons assets licenses vendor \
    -x "*.DS_Store" )
echo "built $OUT ($(du -h "$OUT" | cut -f1))"
unzip -l "$OUT" | tail -1
