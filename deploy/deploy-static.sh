#!/usr/bin/env bash
# Copy the static frontend to a web root.
#
#   CONNECT6_WEB_ROOT=/var/www/connect6/game bash deploy/deploy-static.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="${CONNECT6_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
SRC="$APP_DIR/frontend/"
DST="${CONNECT6_WEB_ROOT:-/var/www/connect6/game}"

if [ ! -d "$SRC" ]; then
  echo "frontend directory not found: $SRC" >&2
  exit 1
fi

mkdir -p "$DST"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete "$SRC" "$DST/"
else
  cp -R "$SRC". "$DST"/
fi

echo "=== deployed files ==="
ls -la "$DST"
