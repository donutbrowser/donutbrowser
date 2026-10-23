#!/usr/bin/env bash
# Writes SHA256SUMS.txt for every Donut* asset of release TAG and uploads it,
# replacing an older one. The app updater refuses a release it cannot verify
# against this file, so release.yml runs it as soon as the builds are up, and
# again once the Flatpak and the Snap are attached.
#
#   bash .github/scripts/release-checksums.sh TAG
#
# Needs GH_TOKEN and GITHUB_REPOSITORY.
set -euo pipefail

tag=$1
assets_dir=$(mktemp -d)
trap 'rm -rf "$assets_dir"' EXIT

gh release download "$tag" --repo "$GITHUB_REPOSITORY" --dir "$assets_dir" --pattern 'Donut*'
cd "$assets_dir"
sha256sum Donut* > SHA256SUMS.txt
cat SHA256SUMS.txt
gh release upload "$tag" SHA256SUMS.txt --clobber --repo "$GITHUB_REPOSITORY"
