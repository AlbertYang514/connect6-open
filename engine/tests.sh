#!/bin/bash
# Connect6 engine regression tests — run against built ./engine binary
set -u
ENGINE=${1:-./engine}
PASS=0; FAIL=0

# Helper: send a JSON move request, capture response moves
ask() {
  # $1 = board string, $2 = side, $3 = difficulty, $4 = stonesThisTurn, optional $5 = timeMs
  local board="$1" side="$2" diff="$3" st="$4" tms="${5:-0}"
  printf '{"board":"%s","side":"%s","difficulty":"%s","stonesThisTurn":%s,"timeMs":%s}\n' \
    "$board" "$side" "$diff" "$st" "$tms" | "$ENGINE"
}

check() {
  # $1 = test name, $2 = condition (0 ok)
  local name="$1" cond="$2"
  if [ "$cond" = "0" ]; then PASS=$((PASS+1)); echo "  PASS: $name";
  else FAIL=$((FAIL+1)); echo "  FAIL: $name"; fi
}

EMPTY=$(python3 -c "print('.'*361)")

echo "== basic move legality =="
# black first move must return exactly 1 move
R=$(ask "$EMPTY" black normal 0)
echo "  black-first resp: $R"
M=$(echo "$R" | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('moves',[])))")
check "black first move returns 1 stone" $([ "$M" = "1" ]; echo $?)

# after black placed 1 stone (center), white must return 2 moves
B1=$(python3 -c "b='.'*361; b=b[:180]+'b'+b[181:]; print(b)")
R=$(ask "$B1" white normal 0)
M=$(echo "$R" | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('moves',[])))")
echo "  white resp: $R"
check "white move returns 2 stones" $([ "$M" = "2" ]; echo $?)

# no overlap: AI must not place on occupied cell
R=$(ask "$B1" white hard 0)
python3 - "$B1" "$R" <<'PY'
import sys,json
b=sys.argv[1]; r=json.loads(sys.argv[2])
moves=r.get('moves',[])
bad=any(b[m[1]*19+m[0]]!='.' for m in moves)
sys.exit(1 if bad else 0)
PY
check "AI does not overwrite existing stone" $?

echo "== win detection / AI tactics =="
# Build a board where white has 5 in a row horizontally and can win in one move (2 stones => place 1 to make 6)
# white stones at y=9, x=4..8 (5 stones), black elsewhere minimal. White to move needs 2 stones,
# so engine should place at x=3 or x=9 (completing 6).
python3 - "$EMPTY" <<'PY'
import sys
b=list(sys.argv[1])
# white 5 in a row at row 9, x=4..8
for x in range(4,9): b[9*19+x]='w'
# give black 1 stone somewhere (to make it white's turn = 2 stones needed is fine, still white can win)
b[0]='b'
print(''.join(b))
PY
WROW=$(python3 - "$EMPTY" <<'PY'
import sys
b=list(sys.argv[1])
for x in range(4,9): b[9*19+x]='w'
b[0]='b'
print(''.join(b))
PY
)
R=$(ask "$WROW" white expert 0)
echo "  white win-in-one resp: $R"
python3 - "$WROW" "$R" <<'PY'
import sys,json
b=sys.argv[1]; r=json.loads(sys.argv[2])
moves=r.get('moves',[])
# winning move is at x=3 or x=9 on row 9
win=any((m[1]==9 and m[0] in (3,9)) for m in moves)
sys.exit(0 if win else 1)
PY
check "AI finds immediate winning move" $?

echo "== black first-move single-stone rule respected =="
# empty board, black expert: should return 1 move, near center-ish (not strictly, but 1 stone)
R=$(ask "$EMPTY" black expert 0)
M=$(echo "$R" | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('moves',[])))")
check "expert black first returns 1" $([ "$M" = "1" ]; echo $?)

echo "== timeout returns legal move =="
R=$(ask "$WROW" white expert 0 50)
python3 - "$WROW" "$R" <<'PY'
import sys,json
b=sys.argv[1]; r=json.loads(sys.argv[2])
moves=r.get('moves',[])
ok=len(moves)>=1 and all(b[m[1]*19+m[0]]=='.' for m in moves)
sys.exit(0 if ok else 1)
PY
check "timeout still returns legal move" $?

echo ""
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ] && exit 0 || exit 1
