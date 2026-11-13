// Connect6 gateway — anonymous game slots + board validation + concurrency +
// native engine bridge.
//
// Listens on 127.0.0.1:18090 by default. Configure with:
//   CONNECT6_HOST, CONNECT6_PORT, CONNECT6_ENGINE,
//   CONNECT6_BASE_PATH, CONNECT6_MAX_ACTIVE_GAMES,
//   CONNECT6_SESSION_TTL_MS, CONNECT6_ENGINE_TIMEOUT_MS
'use strict';

const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');

function envInt(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function normalizeBasePath(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === '/') return '';
  const withLeading = raw.startsWith('/') ? raw : '/' + raw;
  return withLeading.replace(/\/+$/, '');
}

const HOST = process.env.CONNECT6_HOST || '127.0.0.1';
const PORT = envInt('CONNECT6_PORT', 18090);
const BASE_PATH = normalizeBasePath(process.env.CONNECT6_BASE_PATH || '/connect6');
const ENGINE_PATH = process.env.CONNECT6_ENGINE || path.join(__dirname, 'engine');
const MAX_ACTIVE_GAMES = Math.max(1, envInt('CONNECT6_MAX_ACTIVE_GAMES', 5));
const GAME_SESSION_TTL_MS = Math.max(1000, envInt('CONNECT6_SESSION_TTL_MS', 30 * 60 * 1000));
const SESSION_CLEANUP_INTERVAL_MS = Math.max(1000, envInt('CONNECT6_CLEANUP_INTERVAL_MS', 30 * 60 * 1000));
const ENGINE_TIMEOUT_MS = Math.max(1000, envInt('CONNECT6_ENGINE_TIMEOUT_MS', 30 * 1000));

// ---- anonymous active-game slots ----
const sessions = new Map(); // token -> {expires, inFlight}

function cleanupSessions() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now >= session.expires && !session.inFlight) sessions.delete(token);
  }
}

function createSession() {
  cleanupSessions();
  if (sessions.size >= MAX_ACTIVE_GAMES) return null;
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { expires: Date.now() + GAME_SESSION_TTL_MS, inFlight: false });
  return token;
}

function validSession(token) {
  if (!token) return false;
  const session = sessions.get(token);
  if (!session) return false;
  if (Date.now() >= session.expires) {
    if (!session.inFlight) sessions.delete(token);
    return false;
  }
  return true;
}

function releaseSession(token) {
  const session = sessions.get(token);
  if (!session) return;
  session.inFlight = false;
  if (Date.now() >= session.expires) sessions.delete(token);
}

if (typeof setInterval === 'function') {
  setInterval(cleanupSessions, SESSION_CLEANUP_INTERVAL_MS).unref();
}

function reserveSession(req, res) {
  const token = getCookie(req, 'connect6_sid');
  if (validSession(token)) return { token, session: sessions.get(token), created: false };

  // An expired request that is still being processed keeps its slot until it finishes.
  const expiredSession = sessions.get(token);
  if (expiredSession && expiredSession.inFlight) return null;

  const newToken = createSession();
  if (!newToken) return null;
  setSessionCookie(res, req, newToken);
  return { token: newToken, session: sessions.get(newToken), created: true };
}

function setSessionCookie(res, req, token) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  const cookiePath = BASE_PATH || '/';
  res.setHeader(
    'Set-Cookie',
    'connect6_sid=' + token + '; HttpOnly' + secure +
    '; SameSite=Lax; Path=' + cookiePath +
    '; Max-Age=' + Math.floor(GAME_SESSION_TTL_MS / 1000)
  );
}

// ---- board validation ----
const N = 19, NN = N * N;

function validateBoard(boardStr) {
  if (typeof boardStr !== 'string' || boardStr.length !== NN) return { ok: false, reason: 'board length' };
  let b = 0, w = 0;
  for (let i = 0; i < NN; i++) {
    const c = boardStr[i];
    if (c === 'b' || c === 'B' || c === '1') b++;
    else if (c === 'w' || c === 'W' || c === '2') w++;
    else if (c !== '.' && c !== '0' && c !== '-') return { ok: false, reason: 'bad char ' + c };
  }
  // Black moves first; black has either the same number of stones as white or one more.
  if (b < w || b > w + 1) return { ok: false, reason: 'stone count imbalance' };
  return { ok: true, black: b, white: w };
}

// Reject an AI request for a board that already has six in a row.
function hasSix(boardArr, color) {
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    for (const [dx, dy] of dirs) {
      let run = 0;
      let cx = x, cy = y;
      for (let k = 0; k < 6; k++) {
        if (cx < 0 || cx >= N || cy < 0 || cy >= N) break;
        if (boardArr[cy * N + cx] === color) run++; else run = 0;
        if (run >= 6) return true;
        cx += dx; cy += dy;
      }
    }
  }
  return false;
}

function parseBoard(boardStr) {
  const arr = new Int8Array(NN);
  for (let i = 0; i < NN; i++) {
    const c = boardStr[i];
    arr[i] = (c === 'b' || c === 'B' || c === '1') ? 1 : (c === 'w' || c === 'W' || c === '2') ? 2 : 0;
  }
  return arr;
}

// ---- concurrency: serialize engine calls (single engine process, line protocol) ----
let engineProc = null;
let engineBusy = false;
let engineTimer = null;
let pending = [];
let currentReq = null;

function ensureEngine() {
  if (engineProc && !engineProc.killed) return engineProc;

  const proc = spawn(ENGINE_PATH, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  engineProc = proc;
  proc.stdout.setEncoding('utf8');

  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      onEngineLine(line);
    }
  });
  proc.stderr.on('data', (d) => console.error('[engine]', String(d)));
  proc.stdin.on('error', (err) => console.error('[engine stdin]', err.message));

  proc.on('error', (err) => {
    console.error('[engine spawn error]', err.message);
    if (engineProc === proc) engineProc = null;
    failCurrent(503, { error: 'engine unavailable' });
  });

  proc.on('exit', (code, signal) => {
    console.error('[engine] exited', code, signal || '');
    if (engineProc === proc) engineProc = null;
    // A crashed engine must not leave a request or its slot stuck forever.
    failCurrent(503, { error: 'engine unavailable' });
  });

  return proc;
}

function clearEngineTimer() {
  if (engineTimer) {
    clearTimeout(engineTimer);
    engineTimer = null;
  }
}

function failCurrent(code, obj) {
  if (!currentReq) return;
  const req = currentReq;
  currentReq = null;
  engineBusy = false;
  clearEngineTimer();
  releaseSession(req.token);
  respond(req.res, code, obj);
  pump();
}

function onEngineLine(line) {
  if (!currentReq) return;
  const req = currentReq;
  currentReq = null;
  engineBusy = false;
  clearEngineTimer();
  releaseSession(req.token);

  try {
    const j = JSON.parse(line);
    if (j.error) respond(req.res, 400, { error: j.error });
    else respond(req.res, 200, j);
  } catch (e) {
    respond(req.res, 500, { error: 'engine parse error' });
  }
  pump();
}

function pump() {
  while (!engineBusy && pending.length > 0) {
    const task = pending.shift();
    engineBusy = true;
    currentReq = task;

    engineTimer = setTimeout(() => {
      if (currentReq !== task) return;
      console.error('[engine] request timed out');
      if (engineProc && !engineProc.killed) {
        try { engineProc.kill('SIGKILL'); } catch (e) { /* already gone */ }
      }
      failCurrent(504, { error: 'engine timeout' });
    }, ENGINE_TIMEOUT_MS);
    if (typeof engineTimer.unref === 'function') engineTimer.unref();

    const proc = ensureEngine();
    if (!proc) {
      failCurrent(503, { error: 'engine unavailable' });
      return;
    }
    try {
      proc.stdin.write(task.line + '\n');
    } catch (e) {
      failCurrent(503, { error: 'engine write failed' });
      return;
    }
  }
}

function respond(res, code, obj) {
  if (res.headersSent) return;
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function submit(req, res, line) {
  const reservation = reserveSession(req, res);
  if (!reservation) return respond(res, 503, { error: 'game capacity reached' });

  const { token, session, created } = reservation;
  if (session.inFlight || pending.length + (engineBusy ? 1 : 0) >= MAX_ACTIVE_GAMES) {
    // Do not leak a slot that was created for a request that could not run.
    if (created) sessions.delete(token);
    return respond(res, 503, { error: 'game capacity reached' });
  }

  session.inFlight = true;
  pending.push({ req, res, line, token });
  pump();
}

// ---- cookie parsing ----
function getCookie(req, name) {
  const h = req.headers.cookie;
  if (!h) return null;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === name) return v;
  }
  return null;
}

// ---- request body reader ----
function readBody(req, cb) {
  let data = '';
  req.on('data', (c) => {
    data += c;
    if (data.length > 20000) {
      req.destroy();
      return cb({ error: 'body too large' });
    }
  });
  req.on('end', () => cb(null, data));
  req.on('error', () => cb({ error: 'read error' }));
}

function apiPath(rawPath) {
  if (!BASE_PATH) return rawPath;
  if (rawPath === BASE_PATH) return '/';
  if (rawPath.startsWith(BASE_PATH + '/')) return rawPath.slice(BASE_PATH.length);
  // Backward compatibility when a proxy does not strip the old /connect6 prefix.
  if (BASE_PATH !== '/connect6') return rawPath.replace(/^\/connect6(?=\/|$)/, '');
  return rawPath;
}

// ---- server ----
const server = http.createServer((req, res) => {
  const rawPath = new URL(req.url, 'http://x').pathname;
  const p = apiPath(rawPath);

  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (p === '/api/session' && req.method === 'GET') {
    if (!reserveSession(req, res)) return respond(res, 503, { ok: false, error: 'game capacity reached' });
    respond(res, 200, { ok: true });
    return;
  }

  if (p === '/api/move' && req.method === 'POST') {
    readBody(req, (err, body) => {
      if (err) return respond(res, 400, { error: 'bad request' });
      let j;
      try { j = JSON.parse(body); } catch (e) { return respond(res, 400, { error: 'bad json' }); }

      const board = j.board;
      const side = j.side;
      const difficulty = ['easy', 'normal', 'hard', 'expert'].includes(j.difficulty) ? j.difficulty : 'normal';
      const stonesThisTurn = (j.stonesThisTurn === 1 || j.stonesThisTurn === 2) ? j.stonesThisTurn : 0;

      const v = validateBoard(board);
      if (!v.ok) return respond(res, 400, { error: 'invalid board: ' + v.reason });
      if (side !== 'black' && side !== 'white') return respond(res, 400, { error: 'invalid side' });

      const barr = parseBoard(board);
      if (hasSix(barr, 1) || hasSix(barr, 2)) return respond(res, 400, { error: 'game already over' });

      const line = JSON.stringify({ board, side, difficulty, stonesThisTurn, timeMs: j.timeMs || 0 });
      submit(req, res, line);
    });
    return;
  }

  respond(res, 404, { error: 'not found' });
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log('[connect6] gateway listening on ' + HOST + ':' + PORT + ' (base path: ' + (BASE_PATH || '/') + ')');
  });
}

module.exports = {
  server,
  validateBoard,
  hasSix,
  parseBoard,
  getCookie,
  reserveSession,
  sessions,
  CONFIG: {
    HOST,
    PORT,
    BASE_PATH,
    ENGINE_PATH,
    MAX_ACTIVE_GAMES,
    GAME_SESSION_TTL_MS,
    SESSION_CLEANUP_INTERVAL_MS,
    ENGINE_TIMEOUT_MS,
  },
};
