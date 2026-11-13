import subprocess, json, sys
N=19
ENGINE="./backend/engine"

def run(board, side, diff, stones=0):
    bs = "".join(board)
    inp = json.dumps({"board":bs,"side":side,"difficulty":diff,"stonesThisTurn":stones,"timeMs":0})
    out = subprocess.run([ENGINE], input=inp+"\n", capture_output=True, text=True)
    return out.stdout.strip()

def check(name, cond):
    print(("  PASS: " if cond else "  FAIL: ") + name)
    return cond

allok = True

# --- Test 1: white has 5 in a row, white to move, must find the 6th (win in one stone) ---
board=["."]*(N*N)
for x in range(4,9): board[9*N+x]="w"   # row 9, x=4..8 => 5 white
for i in range(5): board[i]="b"          # black 5 stones (legal: black moved, now white)
r=run(board,"white","expert")
j=json.loads(r); moves=j.get("moves",[])
print("T1 resp:", r)
ok = (len(moves)>=1 and any((m[0] in (3,9) and m[1]==9) for m in moves))
allok &= check("T1 white wins in one (completes 6)", ok)

# --- Test 2: black has 5 in a row, black to move, must block/win ---
# black 5 in a row y=0 x=4..8, black to move has 2 stones => can place x=3 to make 6
board=["."]*(N*N)
for x in range(4,9): board[0*N+x]="b"   # black 5 in row 0
for i in range(6): board[10*N+i]="w"    # white 6 stones? no, keep white 5 to be black's turn after white placed
# legal counts: black to move => black == white (black placed first, now equal, black moves again? no)
# Connect6: black first(1), then white(2), black(2)... black to move when black_count == white_count - 0?
# Sequence: b(1)=1b0w, w(2)=1b2w, b(2)=3b2w, w(2)=3b4w, b(2)=5b4w ... 
# black-to-move happens when b==w (e.g. 1b0w, 3b2w, 5b4w). white-to-move when b==w+1.
# So for black to move with black having 5 and white having 5 (b==w -> black to move), use b=5,w=5.
board=["."]*(N*N)
for x in range(4,9): board[0*N+x]="b"   # black 5 in row 0 (x=4..8)
for i in range(5): board[10*N+i]="w"    # white 5 stones elsewhere
r=run(board,"black","expert")
j=json.loads(r); moves=j.get("moves",[])
print("T2 resp:", r)
ok = (len(moves)>=1 and any((m[0] in (3,9) and m[1]==0) for m in moves))
allok &= check("T2 black wins in one (completes 6)", ok)

# --- Test 3: vertical win detection ---
board=["."]*(N*N)
for yy in range(5,10): board[yy*N+3]="w"  # white 5 vertical at x=3, y=5..9
for i in range(5): board[i]="b"
r=run(board,"white","expert")
j=json.loads(r); moves=j.get("moves",[])
print("T3 resp:", r)
ok = (len(moves)>=1 and any((m[0]==3 and m[1] in (4,10)) for m in moves))
allok &= check("T3 white vertical win", ok)

# --- Test 4: diagonal win ---
board=["."]*(N*N)
for k in range(5): board[(5+k)*N+(5+k)]="w"  # main diagonal (5,5)..(9,9)
for i in range(5): board[i]="b"
r=run(board,"white","expert")
j=json.loads(r); moves=j.get("moves",[])
print("T4 resp:", r)
ok = (len(moves)>=1 and any((m[1]-m[0] in (0,) and ((m[0] in (4,10) and m[1] in (4,10)))) for m in moves))
# more precisely: completing cells are (4,4) or (10,10)
ok = any((m[0]==4 and m[1]==4) or (m[0]==10 and m[1]==10) for m in moves)
allok &= check("T4 white main-diagonal win", ok)

# --- Test 5: anti-diagonal win ---
board=["."]*(N*N)
for k in range(5): board[(5+k)*N+(9-k)]="w"  # anti-diag (5,9)..(9,5)
for i in range(5): board[i]="b"
r=run(board,"white","expert")
j=json.loads(r); moves=j.get("moves",[])
print("T5 resp:", r)
ok = any((m[0]==4 and m[1]==10) or (m[0]==10 and m[1]==4) for m in moves)
allok &= check("T5 white anti-diagonal win", ok)

print("\nALL:", "PASS" if allok else "FAIL")
sys.exit(0 if allok else 1)
