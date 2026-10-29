#!/bin/sh
# Make the version being packaged the newest <release> of an AppStream
# metainfo, so software centres show the right version. The Flatpak and the
# Snap run it on their copy; scripts/appimage-metainfo.mjs does the same for
# the AppImage.
#
#   stamp-release.sh <metainfo> <tauri.conf.json>
set -eu
metainfo="$1"
version="$(sed -n 's/^  "version": "\([^"]*\)",$/\1/p' "$2")"
if [ -z "$version" ]; then
  echo "$2 names no version" >&2
  exit 1
fi
if ! grep -q "<release version=\"$version\"" "$metainfo"; then
  sed -i "s|^  <releases>\$|  <releases>\n    <release version=\"$version\" date=\"$(date -u +%Y-%m-%d)\" />|" "$metainfo"
fi
grep -q "<release version=\"$version\"" "$metainfo"
