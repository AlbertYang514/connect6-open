#!/usr/bin/env bash
# Start the Connect6 gateway in the background.
#
# Override with environment variables or a local .env file:
#   CONNECT6_DIR, CONNECT6_ENGINE, CONNECT6_HOST, CONNECT6_PORT,
#   CONNECT6_BASE_PATH, CONNECT6_PID_FILE, CONNECT6_LOG
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="${CONNECT6_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
PID_FILE="${CONNECT6_PID_FILE:-$APP_DIR/gateway.pid}"
LOG_FILE="${CONNECT6_LOG:-$APP_DIR/gateway.log}"
ENGINE="${CONNECT6_ENGINE:-$APP_DIR/backend/engine}"

cd "$APP_DIR"

if [ -f "$PID_FILE" ]; then
  old="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then
    echo "connect6 gateway already running (pid $old)"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

if [ ! -x "$ENGINE" ]; then
  echo "Engine binary not found or not executable: $ENGINE" >&2
  echo "Build it with: g++ -O2 -o engine engine.cpp" >&2
  exit 1
fi

export CONNECT6_ENGINE="$ENGINE"

setsid nohup node "$APP_DIR/backend/gateway.js" >> "$LOG_FILE" 2>&1 < /dev/null &
pid=$!
echo "$pid" > "$PID_FILE"
echo "connect6 gateway started (pid $pid)"
