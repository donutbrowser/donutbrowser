#!/usr/bin/env bash
# Builds the macOS disk image from a built (and, in CI, notarized) Donut.app,
# with the background and the Finder layout in packaging/macos.
#
#   scripts/build-macos-dmg.sh <Donut.app> <output.dmg>
#
# When APPLE_SIGNING_IDENTITY is set, the image is signed with it.
# PYTHON selects the interpreter (3.10 or newer); the default is python3.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <Donut.app> <output.dmg>" >&2
  exit 2
fi

app="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
out="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
root="$(cd "$(dirname "$0")/.." && pwd)"
assets="$root/packaging/macos"
python="${PYTHON:-python3}"

[[ -d "$app" ]] || { echo "app bundle not found: $app" >&2; exit 1; }
"$python" -c 'import sys; sys.exit(sys.version_info < (3, 10))' ||
  { echo "dmgbuild needs Python 3.10 or newer; set PYTHON" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
dmg="$work/$(basename "$out")"

"$python" -m venv "$work/venv"
PIP_DISABLE_PIP_VERSION_CHECK=1 "$work/venv/bin/pip" install --quiet \
  --require-hashes --no-deps --only-binary :all: -r "$assets/dmg-requirements.txt"

"$work/venv/bin/dmgbuild" \
  -s "$assets/dmg-settings.py" \
  -D app="$app" \
  -D background="$assets/dmg-background.png" \
  -D volume_icon="$root/src-tauri/icons/icon.icns" \
  "Donut" "$dmg"

if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  codesign --force --sign "$APPLE_SIGNING_IDENTITY" --timestamp "$dmg"
  codesign --verify --strict "$dmg"
fi
hdiutil verify -quiet "$dmg"

mv -f "$dmg" "$out"
echo "Built $out"
