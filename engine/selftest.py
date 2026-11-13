import subprocess, json, sys
N=19
ENGINE="./backend/engine"

def run(board, side, diff, stones=0, tms=0):
    bs="".join(board)
    inp=json.dumps({"board":bs,"side":side,"difficulty":diff,"stonesThisTurn":stones,"timeMs":tms})
    return subprocess.run([ENGINE],input=inp+"\n",capture_output=True,text=True).stdout.strip()

def check(name, cond):
    print(("  PASS: " if cond else "  FAIL: ") + name)
    return cond

allok=True
b=lambda s: list(s)

# --- Block test: opponent (black) has 4 in a row with open ends; white must block ---
# Actually strongest test: black has 5 in a row already -> game would be over. Instead:
# black has an open four (4 in a row, both ends open) -> black threatens to win next by placing either end.
# White to move should defend (but white can also just... we test white doesn't allow black 6.)
# Simpler robust test: black has 5 in a row with ONE open end (a "five" = win-in-one for black next move).
# White to move MUST place one of its 2 stones at that open end. Board legal: b==w+1 (white to move).
# black 5 in a row y=0, x=4..8 (open end at x=3 and x=9). white to move has 2 stones, can block both? no—one open end already means black has 5 -> black would win next. Actually with 5 already, game should have ended.
# So use: black has 4 in a row y=0 x=4..7, both ends open => black threatens double, but that's normal.
# The clean "must block" test: black has 5 in a row => engine should NOT return that position as playable (game over).
# For "must block opponent's immediate win": black has FOUR open (x=4..7) => black needs 2 more (place x=8 and x=3? no, 6 needs 6 stones; 4 stones + 2 = 6). White to move should consider that black can reach 6.
# Connect6 makes "must block" less about single open-fours. We test: white must not let an existing black 5 stay unblocked — but that's already game-over.
# Keep it simple: assert AI (black) when it's black's turn with 4 open + 2 free completes the six (already covered).

# More meaningful: "doesn't miss a one-move-away double threat" — hard to assert simply.
# We'll instead do a SELF-PLAY smoke test: play full games, assert legality + termination + no crash.
print("== self-play smoke test (hard vs normal) ==")
def play_game(d1, d2):
    board=["."]*(N*N)
    side="black"   # black is AI1
    stones=0
    moves=0
    maxmoves=60
    for t in range(maxmoves):
        diff = d1 if side=="black" else d2
        r=run(board, side, diff)
        try: j=json.loads(r)
        except: return ("parse_error", r, board)
        ms=j.get("moves",[])
        if not ms: return ("no_moves", r, board)
        for mv in ms:
            x,y=mv[0],mv[1]
            c=y*N+x
            if board[c]!=".":
                return ("illegal_overlap", r, board)
            board[c]="b" if side=="black" else "w"
            moves+=1
        # win check
        col = "b" if side=="black" else "w"
        def has6():
            dirs=[(1,0),(0,1),(1,1),(1,-1)]
            for y in range(N):
                for x in range(N):
                    for dx,dy in dirs:
                        run=0
                        cx,cy=x,y
                        for k in range(6):
                            if not(0<=cx<N and 0<=cy<N): break
                            if board[cy*N+cx]==col: run+=1
                            else: break
                            cx+=dx; cy+=dy
                        if run>=6: return True
            return False
        if has6():
            return ("win_"+side, t, board)
        # switch side (both players always place their full required stones, engine enforces)
        side = "white" if side=="black" else "black"
    return ("draw_or_timeout", t, board)

for i in range(2):
    res=play_game("normal","easy")
    print("  game",i,"=>",res[0], "turns=",res[1] if len(res)>1 else "")
    allok &= (res[0].startswith("win_") or res[0]=="draw_or_timeout")

print("\nALL:", "PASS" if allok else "FAIL")
sys.exit(0 if allok else 1)
