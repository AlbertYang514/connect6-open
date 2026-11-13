#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="${CONNECT6_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
PID_FILE="${CONNECT6_PID_FILE:-$APP_DIR/gateway.pid}"

cd "$APP_DIR"

if [ -f "$PID_FILE" ]; then
  old="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then
    kill "$old" 2>/dev/null || true
    sleep 1
  fi
  rm -f "$PID_FILE"
fi

# Fallback for a process launched without the pid file. Scoped to this checkout.
pkill -f "$APP_DIR/backend/gateway.js" 2>/dev/null || true
sleep 1

bash "$SCRIPT_DIR/start-gateway.sh"
sleep 1
echo "=== process check ==="
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "gateway is running (pid $(cat "$PID_FILE"))"
else
  echo "gateway is not running; inspect the log: ${CONNECT6_LOG:-$APP_DIR/gateway.log}"
  exit 1
fi
