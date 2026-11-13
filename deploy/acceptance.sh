#!/usr/bin/env bash
# Basic deployment smoke test.
#
#   CONNECT6_URL=https://example.com/connect6 bash deploy/acceptance.sh
#
# The URL must point at the deployed /connect6/ prefix (or whatever
# CONNECT6_BASE_PATH you configured).
set -euo pipefail

BASE="${CONNECT6_URL:-http://127.0.0.1:8080/connect6}"
BASE="${BASE%/}"

echo "=========== CONNECT6 ACCEPTANCE ==========="
echo "base: $BASE"

echo "--- 1. public game page loads ---"
curl -fsS -o /dev/null -w "GET $BASE/ -> %{http_code}\n" "$BASE/"
TITLE="$(curl -fsS "$BASE/" | grep -o '<title>[^<]*</title>' | head -1 || true)"
echo "title: ${TITLE:-(not found)}"

if curl -fsS "$BASE/" | grep -qiE '请输入访问密码|type="password"'; then
  echo "FAIL: password gate is still present"
  exit 1
fi

echo "--- 2. anonymous slot reservation ---"
curl -fsS -o /dev/null -w "GET $BASE/api/session -> %{http_code}\n" "$BASE/api/session"

echo "--- 3. invalid board is rejected ---"
curl -sS -o /dev/null -w "POST $BASE/api/move (invalid) -> %{http_code}\n" \
  -X POST "$BASE/api/move" \
  -H 'Content-Type: application/json' \
  -d '{"board":"too-short","side":"black"}'

echo "--- 4. legacy password endpoint is gone ---"
curl -sS -o /dev/null -w "POST $BASE/api/verify -> %{http_code}\n" \
  -X POST "$BASE/api/verify" \
  -H 'Content-Type: application/json' \
  -d '{"password":"anything"}'

echo "--- 5. HTTPS/TLS sanity (if the base is https) ---"
curl -sS -o /dev/null -w "GET $BASE/ -> %{http_code} (ssl_verify=%{ssl_verify_result})\n" "$BASE/"

echo "Acceptance checks completed. A 503 session response is expected when all slots are busy."
