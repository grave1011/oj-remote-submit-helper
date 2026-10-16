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

PACKAGE_FILES=(
  manifest.json background.js page-bridge.js
  platforms/atcoder.js platforms/codeforces.js platforms/luogu.js
  README.md
)
if command -v zip >/dev/null 2>&1; then
  zip -r "$PACKAGE_PATH" "${PACKAGE_FILES[@]}"
elif command -v python3 >/dev/null 2>&1; then
  python3 - "$PACKAGE_PATH" "${PACKAGE_FILES[@]}" <<'PYZIP'
import sys
from zipfile import ZipFile, ZIP_DEFLATED
with ZipFile(sys.argv[1], 'w', compression=ZIP_DEFLATED) as archive:
    for name in sys.argv[2:]:
        archive.write(name, name)
PYZIP
else
  echo "Packaging requires zip or python3" >&2
  exit 1
fi

echo "Built: $PACKAGE_PATH"
