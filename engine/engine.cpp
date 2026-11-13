// Connect6 AI Engine — single-file C++17
// Board: 19x19, index = y*19+x.  0 empty, 1 black, 2 white.
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <cmath>
#include <string>
#include <vector>
#include <array>
#include <algorithm>
#include <chrono>
#include <random>
#include <unordered_map>
#include <limits>
#include <climits>
#include <iostream>

using namespace std;

static const int N = 19;
static const int NN = N*N;   // 361
static const int DIRS[4][2] = {{1,0},{0,1},{1,1},{1,-1}};

// ---- precomputed lines (4 directions, all maximal segments through each cell) ----
struct Line { int cells[19]; int len; };
static vector<Line> LINES[NN][4];           // lines through each cell per direction

static int lineAt[NN][4][19];               // for a cell+dir, index into LINES list (0..k-1) per overlapping line is ambiguous;
                                            // instead we store the maximal segment explicitly.

// We precompute a canonical set of segments per direction and, for each cell+dir,
// the id of every maximal line passing through it plus the position of the cell on that line.
struct SegRef { int segId; int pos; };
static vector<SegRef> cellSegs[NN][4];
struct Segment { int cells[19]; int len; };
static vector<Segment> SEGS[4];

static void buildLines() {
    static int dyx[4][2] = {{0,1},{1,0},{1,1},{1,-1}};
    for (int d = 0; d < 4; d++) {
        int dx = dyx[d][0], dy = dyx[d][1];
        // generate maximal segments of length >= 6 (we need 6 for win) up to 19
        for (int sy = 0; sy < N; sy++) for (int sx = 0; sx < N; sx++) {
            // segment starts at (sx,sy) only if it's a start (no predecessor in -dir)
            int px = sx - dx, py = sy - dy;
            if (px >= 0 && px < N && py >= 0 && py < N) continue; // not a start
            Segment s; int x = sx, y = sy; s.len = 0;
            while (x >= 0 && x < N && y >= 0 && y < N) {
                s.cells[s.len++] = y*N + x;
                x += dx; y += dy;
            }
            if (s.len >= 1) {
                int id = (int)SEGS[d].size();
                SEGS[d].push_back(s);
                for (int i = 0; i < s.len; i++) cellSegs[s.cells[i]][d].push_back({id, i});
            }
        }
    }
}

// ---- neighbors (Chebyshev <= R) ----
static vector<int> NEIGH[NN];   // distance 1..3

static void buildNeighbors() {
    for (int y = 0; y < N; y++) for (int x = 0; x < N; x++) {
        int c = y*N+x;
        for (int dy = -3; dy <= 3; dy++) for (int dx = -3; dx <= 3; dx++) {
            if (dx==0 && dy==0) continue;
            int nx=x+dx, ny=y+dy;
            if (nx<0||nx>=N||ny<0||ny>=N) continue;
            NEIGH[c].push_back(ny*N+nx);
        }
    }
}

// ================== Board state ==================
struct State {
    int8_t b[NN];
    int side;            // side to move (1 black 2 white)
    int stonesThisTurn;  // stones already placed this turn (0 or 1 => need 1 or 2 more)
    bool firstMove;      // game is still at black's very first move (empty board, black to move)
    int moveCount;
    uint64_t zhash;
};

// ================== Zobrist ==================
static uint64_t ZOB[NN][3];   // [cell][0 empty,1 black,2 white]
static uint64_t ZOB_SIDE;
static uint64_t ZOB_FIRST;
static uint64_t ZOB_STONES;

static uint64_t rngState = 0x9E3779B97F4A7C15ULL;
static uint64_t rnd64() {
    rngState ^= rngState << 13; rngState ^= rngState >> 7; rngState ^= rngState << 17;
    return rngState;
}
static void initZobrist() {
    for (int c = 0; c < NN; c++) for (int k = 0; k < 3; k++) ZOB[c][k] = rnd64();
    ZOB_SIDE = rnd64(); ZOB_FIRST = rnd64(); ZOB_STONES = rnd64();
}

static inline uint64_t computeHash(const int8_t* b, int side, bool firstMove, int stonesThisTurn) {
    uint64_t h = 0;
    for (int c = 0; c < NN; c++) { int v = b[c]; if (v) h ^= ZOB[c][v]; }
    if (side == 2) h ^= ZOB_SIDE;
    if (firstMove) h ^= ZOB_FIRST;
    if (stonesThisTurn) h ^= ZOB_STONES;
    return h;
}

static inline void applyStone(State& s, int cell, int color) {
    s.b[cell] = (int8_t)color;
    s.zhash ^= ZOB[cell][0];
    s.zhash ^= ZOB[cell][color];
}
static inline void removeStone(State& s, int cell) {
    int old = s.b[cell];
    s.zhash ^= ZOB[cell][old];
    s.zhash ^= ZOB[cell][0];
    s.b[cell] = 0;
}

// ================== six-in-a-row detection ==================
struct WinInfo { bool win; int cells[6]; };

// check if placing 'color' at 'cell' wins (also consider move already placed)
static bool winsAt(const int8_t* b, int cell, int color) {
    // b[cell] should already be color
    for (int d = 0; d < 4; d++) {
        for (const SegRef& sr : cellSegs[cell][d]) {
            const Segment& seg = SEGS[d][sr.segId];
            // count consecutive around pos in both directions
            int run = 1;
            int pos = sr.pos;
            for (int i = pos+1; i < seg.len && b[seg.cells[i]]==color; i++) run++;
            for (int i = pos-1; i >= 0 && b[seg.cells[i]]==color; i--) run++;
            if (run >= 6) return true;
        }
    }
    return false;
}

// return the line of 6 starting cells if color has >=6 somewhere (for game-over checks)
static bool hasSix(const int8_t* b, int color) {
    for (int d = 0; d < 4; d++) {
        for (const Segment& seg : SEGS[d]) {
            int run = 0;
            for (int i = 0; i < seg.len; i++) {
                if (b[seg.cells[i]] == color) { if (++run >= 6) return true; }
                else run = 0;
            }
        }
    }
    return false;
}

// ================== threat / pattern helpers ==================
// For a given cell of a given color, evaluate the line pattern ignoring empties elsewhere.
// We produce a per-direction pattern signature: count run length and open ends up to 6.

// classify a single segment: returns (maxRun, openLeft, openRight) for color
struct RunInfo { int run; int openLeft; int openRight; int jumps; };

static RunInfo lineRun(const Segment& seg, int color, int excludeCell=-1) {
    // simulate scanning; determine longest contiguous run and whether ends can be extended
    // (openleft = empty immediately before the run start; openright = empty after run end)
    // We'll do a simple approach: find runs of 'color', ignoring excludeCell.
    int n = seg.len;
    int bestRun=0, bestL0=0, bestR0=0; int bestStart=-1;
    int i=0;
    const int8_t* b = nullptr; // we'll pass board via lambda style — actually need board; use global temp
    // (rework: we implement as free function taking board)
    return {0,0,0,0};
}
// rework lineRun as free function taking board; also pattern scoring (below)

// count max consecutive run of 'color' on a segment (ignoring excludeCell as empty).
static int maxRunOnSegment(const int8_t* b, const Segment& seg, int color, int excludeCell=-1) {
    int best=0, run=0;
    for (int i=0;i<seg.len;i++){
        int c = seg.cells[i];
        if (c==excludeCell) { run=0; continue; }
        if (b[c]==color) run++; else run=0;
        if (run>best) best=run;
    }
    return best;
}

// Evaluate a single line segment for 'color': how strong is the threat/value.
// Returns a score where higher = more valuable. We treat patterns of contiguous run
// with open ends, plus "one move to make six" and "two moves to make six".
// Because Connect6 places 2 stones per turn, we care a lot about:
//   - already has >=5 with open end (immediate winning threat)
//   - one stone -> six (open four ish)
// We'll compute a per-segment "pattern score".
static const int INF = 1<<28;

static int segmentPatternScore(const int8_t* b, const Segment& seg, int color) {
    int n = seg.len;
    // Build array of occupancy: 0 empty, 1=color, 2=opp
    int8_t a[19];
    for (int i=0;i<n;i++){ int v=b[seg.cells[i]]; a[i]=(v==color)?1:(v==0?0:2); }

    // find the longest contiguous run of 1s that has at least one empty neighbor contiguous,
    // and count "potential win" = a window of length 6 that can be filled by 'color' with
    // 'm' missing stones (m>=0), where window may be blocked.
    // We compute: for each window of 6 consecutive cells,
    //   if no opponent inside -> it's a "potential line". count how many stones needed.
    int bestRun=0; int run=0;
    for (int i=0;i<n;i++){ if(a[i]==1) run++; else run=0; if(run>bestRun)bestRun=run; }

    if (bestRun>=6) return 100000000 + bestRun; // already won

    // classify by contiguous run and open ends
    // find the run(s)
    struct R { int s,e,len; bool leftOpen,rightOpen; };
    vector<R> runs;
    int i=0;
    while (i<n){
        if(a[i]==1){
            int j=i; while(j<n && a[j]==1) j++;
            bool lo = (i-1>=0 && a[i-1]==0);
            bool ro = (j<n && a[j]==0);
            runs.push_back({i,j-1,j-i,lo,ro});
            i=j;
        } else i++;
    }
    if(runs.empty()) return 0;

    int score=0;
    for (auto& r: runs){
        int len=r.len, open=(r.leftOpen?1:0)+(r.rightOpen?1:0);
        // base value by length
        if(len==5){ score += open==2?9000000: (open==1?1500000: 50000); }
        else if(len==4){ score += open==2?600000: (open==1?80000: 4000); }
        else if(len==3){ score += open==2?35000: (open==1?4000: 300); }
        else if(len==2){ score += open==2?900: (open==1?150: 30); }
        else if(len==1){ score += open==2?40: 5; }
    }

    // "one move to six" / "two moves to six" potential over windows of 6
    // window with k empties and (6-k) stones, no opponent -> strong if k small
    for (int w=0; w+6<=n; w++){
        int stones=0, opp=0;
        for(int k=0;k<6;k++){ if(a[w+k]==1)stones++; else if(a[w+k]==2)opp++; }
        if(opp==0 && stones>=3){
            int missing = 6-stones;
            if(missing==1) score += 2500000;       // one stone -> win threat (very hot)
            else if(missing==2) score += 120000;   // two stones -> win (Connect6!)
        }
    }
    return score;
}

// Full positional evaluation of board for 'color'.
static long evaluatePosition(const int8_t* b, int color) {
    long total=0;
    for (int d=0; d<4; d++){
        for (const Segment& seg : SEGS[d]){
            total += segmentPatternScore(b, seg, color);
        }
    }
    return total;
}

// ================== candidate generation ==================
// For a side to move, produce candidate single cells (empty) near stones.
// Returns list of (cell, tacticalScore). Force-includes win/must-block cells.

struct Candidate { int cell; int score; };

static int tacticalPointScore(const int8_t* b, int cell, int color, int opp) {
    // simulate placing color at cell, measure attack gain; and opp defense
    int att=0, def=0;
    // attack: place our stone
    for (int d=0; d<4; d++){
        for (const SegRef& sr : cellSegs[cell][d]){
            const Segment& seg = SEGS[d][sr.segId];
            int sc = segmentPatternScore(b, seg, color);
            // quick: gain approximated by run length around cell
            int run=1;
            int pos=sr.pos;
            for(int i=pos+1;i<seg.len && b[seg.cells[i]]==color;i++) run++;
            for(int i=pos-1;i>=0 && b[seg.cells[i]]==color;i--) run++;
            if(run>=6) att = INF;   // immediate win
            // open ends
            bool lo = (pos-1>=0 && b[seg.cells[pos-1]]==0);
            bool ro = (pos+1<seg.len && b[seg.cells[pos+1]]==0);
            int open=(lo?1:0)+(ro?1:0);
            if(run==5){ att += open>=1? 9000000:1500000; }
            else if(run==4){ att += open==2?600000:(open==1?80000:4000); }
            else if(run==3){ att += open==2?35000:(open==1?4000:300); }
            else if(run==2){ att += open==2?900:150; }
            else if(run==1){ att += open==2?40:5; }
        }
    }
    // defense: how much this cell reduces opp threat (score of opp run if we block)
    for (int d=0; d<4; d++){
        for (const SegRef& sr : cellSegs[cell][d]){
            const Segment& seg = SEGS[d][sr.segId];
            int run=1;
            int pos=sr.pos;
            for(int i=pos+1;i<seg.len && b[seg.cells[i]]==opp;i++) run++;
            for(int i=pos-1;i>=0 && b[seg.cells[i]]==opp;i--) run++;
            if(run>=5) def += (run>=6? INF: 4000000);
            else if(run==4) def += 250000;
            else if(run==3) def += 12000;
            else if(run==2) def += 400;
        }
    }
    // slight center preference
    int x=cell%N, y=cell/N;
    int cx = abs(x-9), cy = abs(y-9);
    int center = 20 - (cx+cy); // 0..20
    return att + def*4/3 + center*30;
}

static vector<Candidate> generateCandidates(const State& s, int K) {
    int color = s.side, opp = 3 - s.side;
    // collect candidate empty cells within Chebyshev 2 of any stone (3 if sparse)
    int8_t mark[NN]; memset(mark,0,sizeof(mark));
    bool anyStone=false;
    for(int c=0;c<NN;c++) if(s.b[c]){anyStone=true;break;}
    vector<Candidate> cands;
    if(!anyStone){
        // empty board: center region
        for(int y=8;y<=10;y++)for(int x=8;x<=10;x++){int c=y*N+x; cands.push_back({c,0});}
        return cands;
    }
    // mark candidates near stones
    for(int c=0;c<NN;c++){
        if(s.b[c]==0) continue;
        for(int n : NEIGH[c]) if(s.b[n]==0 && !mark[n]){ mark[n]=1; }
    }
    // also if very few candidates, expand
    int cnt=0;
    for(int c=0;c<NN;c++) if(mark[c]) cnt++;
    if(cnt < K){
        // expand to distance 3 via NEIGH of NEIGH
        int8_t mark2[NN]; memcpy(mark2,mark,sizeof(mark));
        for(int c=0;c<NN;c++) if(mark[c]) for(int n: NEIGH[c]) if(s.b[n]==0) mark2[n]=1;
        memcpy(mark,mark2,sizeof(mark));
    }
    for(int c=0;c<NN;c++){
        if(mark[c]) {
            int sc = tacticalPointScore(s.b, c, color, opp);
            cands.push_back({c, sc});
        }
    }
    // sort descending by score
    sort(cands.begin(), cands.end(), [](const Candidate&a,const Candidate&b){return a.score>b.score;});
    // keep top K, but force-keep any "immediate win" (score==INF) — they'll be at top anyway
    if((int)cands.size()>K) cands.resize(K);

    // ALWAYS ensure all immediate-winning cells are included even if beyond K
    // (we separately detect wins in search; candidate cap mainly limits breadth)
    return cands;
}

// ================== move helpers ==================
// count of stones `side` must place to finish its move (not counting stonesThisTurn already placed)
static int requiredStonesFor(const State& s, int side) {
    if (side == 1) {
        int any=0; for(int c=0;c<NN;c++) if(s.b[c]) any=1;
        if(!any) return 1;   // black's first move of the game
    }
    return 2;
}
// stones still needed by s.side in the current move (used at root)
static int stonesNeeded(const State& s) {
    return requiredStonesFor(s, s.side);
}

// make a single-stone move; returns true if this move immediately wins
static bool makeMove(State& s, int cell) {
    applyStone(s, cell, s.side);
    s.moveCount++;
    bool win = winsAt(s.b, cell, s.side);
    return win;
}
// undo a single-stone move (non-winning partial)
static void undoMove(State& s, int cell) {
    removeStone(s, cell);
    s.moveCount--;
}

// ================== Transposition Table ==================
struct TTEntry {
    uint64_t hash;
    int depth;          // depth searched (in half-moves remaining)
    int score;
    int8_t bound;       // 0 exact, 1 lower, 2 upper
    int16_t bestCell;   // best single move for move ordering
    int8_t valid;
};
static const int TT_SIZE = 1<<20; // ~1M
static vector<TTEntry> TT;
static inline int ttIndex(uint64_t h){ return (int)(h & (TT_SIZE-1)); }
static void ttStore(uint64_t h, int depth, int score, int bound, int bestCell){
    TTEntry& e = TT[ttIndex(h)];
    // replacement: prefer greater depth or exact
    if (e.valid && e.depth > depth) return;
    e.hash=h; e.depth=depth; e.score=score; e.bound=bound; e.bestCell=(int16_t)bestCell; e.valid=1;
}
static int ttProbe(uint64_t h, int depth, int alpha, int beta, int* bestCell){
    TTEntry& e = TT[ttIndex(h)];
    if(!e.valid || e.hash!=h) return 0x7fffffff; // no hit
    if(bestCell) *bestCell = e.bestCell;
    if(e.depth>=depth){
        if(e.bound==0) return e.score;
        if(e.bound==1 && e.score>=beta) return e.score;
        if(e.bound==2 && e.score<=alpha) return e.score;
    }
    return 0x7fffffff;
}

// ================== search context ==================
struct SearchCtx {
    int K;               // candidate cap
    int maxDepth;
    int64_t nodes;
    chrono::steady_clock::time_point t0;
    int64_t timeBudgetMs;
    bool timedOut;
    int bestCell[2];     // best first stone (and second) from root
    int bestScore;
    int completedDepth;
    uint64_t rootHash;
    bool easyRandom;     // for easy: inject randomness
    uint32_t seed;
};

static inline bool timeUp(SearchCtx& ctx){
    if ((++ctx.nodes & 0x3f) != 0) return ctx.timedOut;
    auto now = chrono::steady_clock::now();
    auto ms = chrono::duration_cast<chrono::milliseconds>(now - ctx.t0).count();
    if (ms >= ctx.timeBudgetMs) { ctx.timedOut = true; return true; }
    return false;
}

// static evaluation from side-to-move perspective
static int staticEval(const State& s, SearchCtx& ctx){
    int me = s.side, opp = 3-s.side;
    long att = evaluatePosition(s.b, me);
    long def = evaluatePosition(s.b, opp);
    // defense weight slightly > 1
    long score = att - (long)(def * 1.15);
    // clamp to int range
    if(score >  INT_MAX-1000) score =  INT_MAX-1000;
    if(score < -INT_MAX+1000) score = -INT_MAX+1000;
    // small random for easy
    if(ctx.easyRandom){
        uint32_t r = (ctx.seed = ctx.seed*1664525u+1013904223u);
        score += (int)(r%100) - 50;
    }
    return (int)score;
}

// check if 'side' can win in one more stone — returns winning empty cell or -1
static int findWinningMove(State& s, int side){
    for(int c=0;c<NN;c++){
        if(s.b[c]!=0) continue;
        s.b[c] = (int8_t)side;
        bool w = winsAt(s.b, c, side);
        s.b[c] = 0;
        if(w) return c;
    }
    return -1;
}

// collect immediate winning moves for 'side' (a cell that makes 6 in a row for side)
static void collectWinningMoves(State& s, int side, vector<int>& out){
    for(int c=0;c<NN;c++){
        if(s.b[c]!=0) continue;
        s.b[c]=(int8_t)side;
        bool w = winsAt(s.b,c,side);
        s.b[c]=0;
        if(w) out.push_back(c);
    }
}

// ================== Negamax with alpha-beta ==================
// We search half-moves (single stones). The state `s` holds the board and `s.side`
// is the color whose turn it is. `stonesLeft` = how many MORE stones this same
// side must place to finish its current move (1 or 2). For black's very first
// move, the required total is 1, so stonesLeft starts at 1 and the opponent is
// next after that single stone.
//
// Returns the score from `s.side`'s perspective at this node.

static int negamax(State& s, int depth, int alpha, int beta, int stonesLeft, SearchCtx& ctx);

static void orderMoves(State& s, vector<int>& moves, int ttBest){
    int me=s.side, opp=3-s.side;
    vector<pair<int,int>> scored; scored.reserve(moves.size());
    for(int m: moves){
        int sc = tacticalPointScore(s.b, m, me, opp);
        if(m==ttBest) sc += 100000000;
        scored.push_back({-sc, m});
    }
    sort(scored.begin(), scored.end());
    for(size_t i=0;i<moves.size();i++) moves[i]=scored[i].second;
}

static int negamax(State& s, int depth, int alpha, int beta, int stonesLeft, SearchCtx& ctx){
    if(timeUp(ctx)) return 0;

    if(depth<=0){
        return staticEval(s, ctx);
    }

    int opp = 3 - s.side;

    // TT probe (key includes side + stonesLeft through zobrist components set by caller)
    int ttBest = -1;
    int saved = ttProbe(s.zhash, depth, alpha, beta, &ttBest);
    if(saved != 0x7fffffff && !ctx.easyRandom) return saved;

    vector<int> moves;
    vector<Candidate> cands = generateCandidates(s, ctx.K);
    moves.reserve(cands.size());
    for(auto&c: cands) moves.push_back(c.cell);
    if(moves.empty()) return 0; // draw-ish

    orderMoves(s, moves, ttBest);

    int alphaOrig = alpha;
    int best = -INT_MAX;
    int bestCell = -1;

    for(int m: moves){
        bool win = makeMove(s, m);   // places s.side's stone
        int score;
        if(win){
            score = 100000000 + depth*1000;  // immediate win for s.side (mate-ish)
        } else if(stonesLeft > 1) {
            // same side places its next (second) stone
            score = negamax(s, depth-1, alpha, beta, stonesLeft-1, ctx);
        } else {
            // this side finished its move -> opponent to move, negate
            int oldSide = s.side;
            s.side = opp;
            s.zhash ^= ZOB_SIDE;
            int nsl = requiredStonesFor(s, opp);
            score = -negamax(s, depth-1, -beta, -alpha, nsl, ctx);
            s.side = oldSide;
            s.zhash ^= ZOB_SIDE;
        }
        undoMove(s, m);

        if(score > best){ best = score; bestCell = m; }
        if(score > alpha) alpha = score;
        if(alpha >= beta) break;
    }

    int bound = (best <= alphaOrig) ? 2 : (best >= beta ? 1 : 0);
    ttStore(s.zhash, depth, best, (int8_t)bound, bestCell);
    return best;
}

// ================== Threat search ==================
// A simplified but effective tactical check: for side-to-move, determine if there is a
// forced move — i.e., the opponent has an immediate win we MUST block, or we have a
// two-stone combination that creates an unstoppable double threat.
// We model "threat" as after placing our required stones, we create >=2 distinct
// immediate winning points (six-in-one-move) that cannot both be blocked by one reply.

// Count how many distinct cells would be an immediate six for 'color' if 'color' gets one more stone.
// A position has a "win threat" if placing one stone creates a six.
// We compute number of independent immediate-win cells the opponent would face.

// For threat search, given a candidate pair (a,b) for 'me', simulate placing them and
// check if opponent cannot avoid loss: opponent must block all our immediate win cells,
// but can only place at most stones (1 or 2). If distinct immediate-win cells > opp stones -> forced win.

struct PairResult { int a, b; int score; };

// After a hypothetical board, count distinct cells where 'me' has an immediate win (place one -> six).
static int countImmediateWins(State& s, int me){
    int cnt=0;
    for(int c=0;c<NN;c++){
        if(s.b[c]!=0) continue;
        s.b[c]=(int8_t)me;
        bool w = winsAt(s.b,c,me);
        s.b[c]=0;
        if(w) cnt++;
    }
    return cnt;
}

static int firstImmediateWin(State& s, int me){
    for(int c=0;c<NN;c++){
        if(s.b[c]!=0) continue;
        s.b[c]=(int8_t)me;
        bool w = winsAt(s.b,c,me);
        s.b[c]=0;
        if(w) return c;
    }
    return -1;
}

// Threat search: evaluate a move pair for tactical forcing potential.
// Returns a bonus score if the pair produces a forced win / double threat.
// Higher = stronger tactical value.
static int threatBonus(State& s, int a, int b, int me){
    // place both stones (assume valid, non-winning separately already handled)
    applyStone(s, a, me);
    applyStone(s, b, me);

    int bonus = 0;
    // 1) does 'me' now have a direct single-stone win available? (opponent cannot block all)
    // if we place a,b and then we still have an immediate win that opp can't fully block...
    int iw = firstImmediateWin(s, me);
    if(iw >= 0){
        // we have a winning threat already on board; opponent on their move must block,
        // but if we have >=2 immediate-win cells it's unstoppable
         bonus += 20000000;
    }
    // count immediate win cells opponent must cover
    int cnt = countImmediateWins(s, me);
    // opponent can block 'opp stones' cells (1 if opp is black first move, else 2)
    int oppStones = 2; // approximate (opponent's required stones; black first may be 1)
    if(cnt > oppStones){
        bonus += 15000000 + cnt*500000;  // unstoppable double threat
    } else if(cnt >= 2){
        bonus += 3000000; // double threat (trouble for opp)
    }

    // remove
    removeStone(s, a);
    removeStone(s, b);
    return bonus;
}

// ================== Root move generation (pairs) ==================
// The engine decides its full move: 1 stone (black first) or a pair (a,b).
// We evaluate pairs via a shallow search, then feed best to iterative deepening.

struct RootMove { vector<int> cells; int score; int depth; };

// search a root: returns best full move (vector of 1 or 2 cells), with stats.
static void searchRoot(State& root, SearchCtx& ctx, vector<int>& result, int& finalDepth, int& finalScore, int64_t& finalNodes){
    int need = stonesNeeded(root);

    // --- immediate tactical handling begins BEFORE any search ---

    // If we (side to move) can win immediately with required stones, do it.
    // Case need==1: find single winning stone.
    // Case need==2: find a pair where first stone alone wins (win -> done), else pair making win.

    // 1) single-stone win for 'me' (only relevant when need==1, or as first of pair)
    {
        int w = firstImmediateWin(root, root.side);
        if(need==1 && w>=0){
            result.push_back(w); finalDepth=1; finalScore=100000000; finalNodes=1; return;
        }
    }

    // 2) For need==2, check each candidate first stone; if any first stone wins alone -> play it (done, no second).
    vector<int> firsts;
    {
        vector<Candidate> c = generateCandidates(root, ctx.K);
        for(auto&x:c) firsts.push_back(x.cell);
    }

    if(need==2){
        // First stone immediate win -> return (only 1 needed because game already over)
        for(int a:firsts){
            State tmp = root;
            bool w = makeMove(tmp, a);
            undoMove(tmp, a);
            (void)w;
            // need to test win on the ORIGINAL board after placing a
            int8_t saved = root.b[a];
            root.b[a]=(int8_t)root.side;
            bool wins = winsAt(root.b, a, root.side);
            root.b[a]=saved;
            if(wins){
                result.push_back(a); finalDepth=1; finalScore=100000000; finalNodes=1; return;
            }
        }
    }

    // 3) Opponent immediate-win block: find cells that would let opp win next; we MUST block.
    // Generate opp winning cells and block the most urgent.
    // (search will naturally value them; but ensure we never hang a forced loss: handled in eval)
    int opp = 3 - root.side;

    // --- build ordered move list (pairs) ---
    // Evaluate each single candidate by a quick 2-ply-ish lookahead isn't cheap; do:
    // order first-stones by tactical score, then second-stone within top candidates.

    vector<int> candList = firsts;
    // sort candidates by tactical score desc
    {
        vector<pair<int,int>> sc;
        for(int m: candList) sc.push_back({-tacticalPointScore(root.b,m,root.side,opp), m});
        sort(sc.begin(),sc.end());
        for(size_t i=0;i<candList.size();i++) candList[i]=sc[i].second;
    }

    // iterative deepening
    ctx.maxDepth = 1;
    ctx.completedDepth = 0;
    int bestScore = -INT_MAX;
    vector<int> bestCells;
    ctx.rootHash = root.zhash;
    ctx.t0 = chrono::steady_clock::now();
    ctx.timedOut = false;
    ctx.nodes = 0;

    int maxDepthCap = 14; // half-moves

    for(int d=1; d<=maxDepthCap && !ctx.timedOut; d++){
        ctx.maxDepth = d;
        int alpha = -INT_MAX, beta = INT_MAX;
        int localBest = -INT_MAX;
        vector<int> localCells;

        // for need==1: single stone
        if(need==1){
            for(int a: candList){
                State s = root;
                bool win = makeMove(s, a);
                int sc;
                if(win){ sc = 100000000 + 1000; }
                else {
                    s.side = opp; s.zhash ^= ZOB_SIDE;
                    int sl = requiredStonesFor(s, opp);
                    sc = -negamax(s, d-1, -beta, -alpha, sl, ctx);
                    s.side = root.side; s.zhash ^= ZOB_SIDE;
                }
                undoMove(s, a);
                if(sc>localBest){ localBest=sc; localCells={a}; }
                if(sc>alpha) alpha=sc;
                if(ctx.timedOut) break;
            }
        } else {
            // need==2: iterate first stone, then search second stone
            int n1 = (int)candList.size();
            // first stone loop
            for(int i=0;i<n1 && !ctx.timedOut;i++){
                int a = candList[i];
                State s = root;
                bool win = makeMove(s, a);
                if(win){ undoMove(s,a); continue; } // handled above (single win) — skip
                // second stone candidates: same candidate set (or a nearby subset)
                // generate second-stone candidates on the new board (different cell)
                vector<Candidate> cc = generateCandidates(s, ctx.K);
                // place second stone and evaluate
                for(auto& c2 : cc){
                    int b = c2.cell;
                    if(b==a) continue;
                    int savedb = s.b[b];
                    bool win2 = makeMove(s, b);
                    int sc;
                    if(win2){
                        sc = 100000000 + 1000;
                    } else {
                        s.side = opp; s.zhash ^= ZOB_SIDE;
                        int sl = requiredStonesFor(s, opp);
                        sc = -negamax(s, d-1, -beta, -alpha, sl, ctx);
                        s.side = root.side; s.zhash ^= ZOB_SIDE;
                    }
                    undoMove(s, b);
                    if(sc>localBest){ localBest=sc; localCells={a,b}; }
                    if(sc>alpha) alpha=sc;
                    if(ctx.timedOut) break;
                }
                undoMove(s, a);
            }
        }

        if(ctx.timedOut) break; // discard incomplete iteration

        if(localCells.empty()){
            // fallback: just take first candidate (draw-ish)
            localCells = need==1 ? vector<int>{candList[0]} : vector<int>{candList[0], candList.size()>1?candList[1]:candList[0]};
            // ensure distinct
            if(localCells.size()==2 && localCells[0]==localCells[1] && candList.size()>1) localCells[1]=candList[1];
        }

        bestScore = localBest;
        bestCells = localCells;
        ctx.completedDepth = d;
        ctx.bestScore = bestScore;
        if(bestScore > 90000000) break; // found forced win, stop
    }

    result = bestCells;
    if(result.empty()){
        // safety fallback (should not happen)
        result = need==1 ? vector<int>{candList.empty()? (N*N/2) : candList[0]}
                         : vector<int>{candList[0]};
    }
    // ensure pair distinct & valid
    if(result.size()==2 && result[0]==result[1]){
        // replace second with next candidate
        result[1] = (candList.size()>1 && candList[1]!=result[0]) ? candList[1] : (result[0]+1)%NN;
    }
    finalDepth = ctx.completedDepth;
    finalScore = ctx.bestScore;
    finalNodes = ctx.nodes;
}

// ================== JSON parse (minimal) ==================
static string jsonGet(const string& j, const string& key){
    string k = "\"" + key + "\"";
    size_t p = j.find(k);
    if(p==string::npos) return "";
    p += k.size();
    p = j.find(':', p);
    if(p==string::npos) return "";
    p++;
    while(p<j.size() && (j[p]==' '||j[p]=='\t')) p++;
    if(p>=j.size()) return "";
    if(j[p]=='"'){
        p++;
        size_t e = j.find('"', p);
        if(e==string::npos) return "";
        return j.substr(p, e-p);
    } else {
        size_t e=p;
        while(e<j.size() && j[e]!=',' && j[e]!='}' && j[e]!=']') e++;
        string v = j.substr(p,e-p);
        size_t a=0,b=v.size(); while(a<b&&(v[a]==' '))a++; while(b>a&&(v[b-1]==' '))b--;
        return v.substr(a,b-a);
    }
}

static int parseIntSafe(const string& s, int def){ if(s.empty()) return def; return atoi(s.c_str()); }

static void setDifficulty(SearchCtx& ctx, const string& diff){
    ctx.easyRandom=false;
    if(diff=="easy"){ ctx.K=8; ctx.timeBudgetMs=90; ctx.easyRandom=true; ctx.seed=12345; }
    else if(diff=="normal"){ ctx.K=14; ctx.timeBudgetMs=400; }
    else if(diff=="hard"){ ctx.K=20; ctx.timeBudgetMs=1600; }
    else { ctx.K=28; ctx.timeBudgetMs=4500; } // expert
}

int main(){
    buildLines();
    buildNeighbors();
    initZobrist();
    TT.assign(TT_SIZE, TTEntry{0,0,0,0,0,0});

    string line;
    while(getline(cin, line)){
        if(line.empty()) continue;
        string boardStr = jsonGet(line, "board");
        string side = jsonGet(line, "side");
        string diff = jsonGet(line, "difficulty");
        int stonesThisTurn = parseIntSafe(jsonGet(line, "stonesThisTurn"), 0);
        int timeMs = parseIntSafe(jsonGet(line, "timeMs"), 0);

        State root;
        memset(root.b, 0, sizeof(root.b));
        if((int)boardStr.size()!=NN){
            printf("{\"error\":\"bad board length\"}\n"); fflush(stdout); continue;
        }
        for(int i=0;i<NN;i++){
            char ch=boardStr[i];
            if(ch=='b'||ch=='B'||ch=='1') root.b[i]=1;
            else if(ch=='w'||ch=='W'||ch=='2') root.b[i]=2;
            else root.b[i]=0;
        }
        root.side = (side=="black"||side=="b"||side=="1")?1:2;
        root.stonesThisTurn = stonesThisTurn;
        int blackCnt=0, whiteCnt=0;
        for(int i=0;i<NN;i++){ if(root.b[i]==1)blackCnt++; else if(root.b[i]==2)whiteCnt++; }
        root.firstMove = (blackCnt==0 && whiteCnt==0 && root.side==1);
        root.moveCount = blackCnt + whiteCnt;
        root.zhash = computeHash(root.b, root.side, root.firstMove, root.stonesThisTurn);

        SearchCtx ctx;
        setDifficulty(ctx, diff);
        if(timeMs>0) ctx.timeBudgetMs = timeMs;
        ctx.nodes=0; ctx.timedOut=false; ctx.bestScore=0; ctx.completedDepth=0;
        ctx.maxDepth=0;

        vector<int> moves;
        int d=0, sc=0; int64_t nd=0;
        auto t0 = chrono::steady_clock::now();
        searchRoot(root, ctx, moves, d, sc, nd);
        auto t1 = chrono::steady_clock::now();
        long elapsed = chrono::duration_cast<chrono::milliseconds>(t1-t0).count();

        string out = "{\"moves\":[";
        for(size_t i=0;i<moves.size();i++){
            int c=moves[i]; int x=c%N, y=c/N;
            char buf[32]; snprintf(buf,sizeof(buf),"[%d,%d]",x,y);
            if(i) out+=",";
            out+=buf;
        }
        out+="]";
        char nb[96];
        snprintf(nb,sizeof(nb),",\"depth\":%d,\"nodes\":%lld,\"score\":%d,\"elapsedMs\":%ld", d, (long long)nd, sc, elapsed);
        out+=nb;
        out+="}";
        printf("%s\n", out.c_str());
        fflush(stdout);
    }
    return 0;
}
