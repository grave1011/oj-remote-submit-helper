#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

VERSION="$(sed -n 's/.*"version":[[:space:]]*"\([^"]*\)".*/\1/p' manifest.json | head -n1)"
if [[ -z "${VERSION}" ]]; then
  echo "Failed to read version from manifest.json" >&2
  exit 1
fi

DIST_DIR="$SCRIPT_DIR/dist"
PACKAGE_NAME="oj-remote-submit-helper-lite-v${VERSION}.zip"
PACKAGE_PATH="$DIST_DIR/$PACKAGE_NAME"

mkdir -p "$DIST_DIR"
rm -f "$PACKAGE_PATH"

zip -r "$PACKAGE_PATH" \
  manifest.json \
  background.js \
  page-bridge.js \
  README.md \
  CHANGELOG.md \
  PRIVACY.md \
  RELEASE.md \
  STORE_LISTING.md

echo "Built: $PACKAGE_PATH"
