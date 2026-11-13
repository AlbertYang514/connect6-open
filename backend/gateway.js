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

// Client-supplied search budgets are clamped by the gateway; the engine must
// never be allowed to run for an arbitrarily long time on one request.
const MAX_CLIENT_TIME_MS = Math.max(0, envInt('CONNECT6_MAX_CLIENT_TIME_MS', 10 * 1000));
const MAX_REQUEST_BYTES = Math.max(1024, envInt('CONNECT6_MAX_REQUEST_BYTES', 20 * 1000));
const MAX_ENGINE_LINE_BYTES = Math.max(1024, envInt('CONNECT6_MAX_ENGINE_LINE_BYTES', 1024 * 1024));

// Lightweight in-memory limits: enough to stop a single client from burning
// every anonymous slot, without introducing accounts or external storage.
const REQUEST_RATE_WINDOW_MS = Math.max(1000, envInt('CONNECT6_RATE_WINDOW_MS', 60 * 1000));
const REQUEST_RATE_MAX = Math.max(1, envInt('CONNECT6_RATE_LIMIT_PER_WINDOW', 120));
const SESSION_RATE_WINDOW_MS = Math.max(1000, envInt('CONNECT6_SESSION_RATE_WINDOW_MS', 10 * 60 * 1000));
const SESSION_RATE_MAX = Math.max(1, envInt('CONNECT6_SESSION_LIMIT_PER_WINDOW', 10));

// ---- anonymous active-game slots ----
const sessions = new Map(); // token -> {expires, inFlight}

// ---- per-client rate limits (fixed window) ----
const rateBuckets = new Map(); // key -> {count, resetAt}

function clientIp(req) {
  const remote = (req.socket && req.socket.remoteAddress) || '';
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  const forwarded = req.headers['x-forwarded-for'];
  if (loopback && typeof forwarded === 'string') {
    const hops = forwarded.split(',').map((part) => part.trim()).filter(Boolean);
    // The last hop is the one appended by our own reverse proxy, so it is the
    // only entry a client cannot forge.
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return remote || 'unknown';
}

function takeToken(key, limit, windowMs) {
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    rateBuckets.set(key, bucket);
  }
  if (bucket.count >= limit) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }
  bucket.count += 1;
  return { ok: true };
}

function cleanupSessions() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now >= session.expires && !session.inFlight) sessions.delete(token);
  }
  for (const [key, bucket] of rateBuckets) {
    if (now >= bucket.resetAt) rateBuckets.delete(key);
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
  if (expiredSession && expiredSession.inFlight) return { error: 'busy' };

  // Only new anonymous slots are rationed. A client that keeps its cookie is
  // never punished by this limit.
  const rate = takeToken('session:' + clientIp(req), SESSION_RATE_MAX, SESSION_RATE_WINDOW_MS);
  if (!rate.ok) return { error: 'rate', retryAfter: rate.retryAfter };

  const newToken = createSession();
  if (!newToken) return { error: 'capacity' };
  setSessionCookie(res, req, newToken);
  return { token: newToken, session: sessions.get(newToken), created: true };
}

function respondSessionError(res, reservation) {
  if (reservation.error === 'rate') {
    res.setHeader('Retry-After', String(reservation.retryAfter));
    return respond(res, 429, { error: 'too many new sessions' });
  }
  return respond(res, 503, { error: 'game capacity reached' });
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

  let proc;
  try {
    proc = spawn(ENGINE_PATH, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    console.error('[engine spawn error]', err.message);
    return null;
  }
  engineProc = proc;
  proc.stdout.setEncoding('utf8');

  let buf = '';
  let overflowed = false;
  const dropEngine = (message) => {
    if (overflowed) return;
    overflowed = true;
    buf = '';
    console.error('[engine] ' + message);
    try { proc.kill('SIGKILL'); } catch (e) { /* already gone */ }
    if (engineProc === proc) engineProc = null;
    failCurrent(502, { error: 'engine output too large' });
  };
  proc.stdout.on('data', (d) => {
    if (overflowed) return;
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      if (nl > MAX_ENGINE_LINE_BYTES) return dropEngine('response line exceeds limit');
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      onEngineLine(line);
    }
    if (buf.length > MAX_ENGINE_LINE_BYTES) dropEngine('unterminated output exceeds limit');
  });
  proc.stderr.on('data', (d) => console.error('[engine]', String(d)));
  proc.stdin.on('error', (err) => console.error('[engine stdin]', err.message));

  proc.on('error', (err) => {
    console.error('[engine spawn error]', err.message);
    if (engineProc === proc) engineProc = null;
    // Only fail the request that was actually running on this engine.
    if (currentReq && currentReq.proc === proc) failCurrent(503, { error: 'engine unavailable' });
  });

  proc.on('exit', (code, signal) => {
    console.error('[engine] exited', code, signal || '');
    if (engineProc === proc) engineProc = null;
    // A crashed engine must not leave a request or its slot stuck forever.
    if (currentReq && currentReq.proc === proc) failCurrent(503, { error: 'engine unavailable' });
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
  if (!req.aborted) respond(req.res, code, obj);
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
    if (j === null || typeof j !== 'object' || Array.isArray(j)) {
      if (!req.aborted) respond(req.res, 500, { error: 'engine parse error' });
    } else if (j.error) {
      if (!req.aborted) respond(req.res, 400, { error: String(j.error) });
    } else {
      if (!req.aborted) respond(req.res, 200, j);
    }
  } catch (e) {
    if (!req.aborted) respond(req.res, 500, { error: 'engine parse error' });
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
    task.proc = proc;
    try {
      proc.stdin.write(task.line + '\n');
    } catch (e) {
      failCurrent(503, { error: 'engine write failed' });
      return;
    }
  }
}

function respond(res, code, obj) {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  try {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  } catch (e) {
    // The client may have gone away mid-response; never let that crash the gateway.
    try { res.destroy(); } catch (ignored) { /* nothing left to do */ }
  }
}

function submit(req, res, line) {
  const reservation = reserveSession(req, res);
  if (reservation.error) return respondSessionError(res, reservation);

  const { token, session, created } = reservation;
  if (session.inFlight || pending.length + (engineBusy ? 1 : 0) >= MAX_ACTIVE_GAMES) {
    // Do not leak a slot that was created for a request that could not run.
    if (created) sessions.delete(token);
    return respond(res, 503, { error: 'game capacity reached' });
  }

  const task = { req, res, line, token, aborted: false };
  session.inFlight = true;
  pending.push(task);
  req.once('aborted', () => cancelTask(task));
  pump();
}

function cancelTask(task) {
  const index = pending.indexOf(task);
  if (index >= 0) {
    pending.splice(index, 1);
    releaseSession(task.token);
    return;
  }
  // Already running: let the engine finish, but nobody is waiting any more.
  if (currentReq === task) task.aborted = true;
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
  const chunks = [];
  let size = 0;
  let done = false;
  const finish = (err, body) => {
    if (done) return;
    done = true;
    cb(err, body);
  };
  req.on('data', (chunk) => {
    if (done) return;
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      // Stop buffering; discard the rest so the 413 can still be delivered.
      finish({ status: 413, error: 'body too large' });
      req.resume();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
  req.on('error', () => finish({ status: 400, error: 'read error' }));
  req.on('aborted', () => finish({ status: 400, error: 'aborted' }));
}

function parseJsonObject(body) {
  let value;
  try {
    value = JSON.parse(body);
  } catch (e) {
    return { ok: false };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
  return { ok: true, value };
}

function validateTimeMs(value) {
  if (value === undefined) return { ok: true, timeMs: 0 };
  if (typeof value !== 'number' || !Number.isInteger(value)) return { ok: false };
  if (value < 0 || value > MAX_CLIENT_TIME_MS) return { ok: false };
  return { ok: true, timeMs: value };
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
function handleRequest(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');

  let rawPath;
  try {
    rawPath = new URL(req.url, 'http://x').pathname;
  } catch (e) {
    return respond(res, 400, { error: 'bad request' });
  }
  const p = apiPath(rawPath);

  const rate = takeToken('request:' + clientIp(req), REQUEST_RATE_MAX, REQUEST_RATE_WINDOW_MS);
  if (!rate.ok) {
    res.setHeader('Retry-After', String(rate.retryAfter));
    return respond(res, 429, { error: 'too many requests' });
  }

  if (p === '/api/session' && req.method === 'GET') {
    const reservation = reserveSession(req, res);
    if (reservation.error) return respondSessionError(res, reservation);
    respond(res, 200, { ok: true });
    return;
  }

  if (p === '/api/move' && req.method === 'POST') {
    readBody(req, (err, body) => {
      if (err) {
        if (err.status === 413) res.setHeader('Connection', 'close');
        return respond(res, err.status || 400, { error: err.error || 'bad request' });
      }

      const parsed = parseJsonObject(body);
      if (!parsed.ok) return respond(res, 400, { error: 'bad json' });
      const j = parsed.value;

      const board = j.board;
      const side = j.side;
      const difficulty = ['easy', 'normal', 'hard', 'expert'].includes(j.difficulty) ? j.difficulty : 'normal';
      const stonesThisTurn = (j.stonesThisTurn === 1 || j.stonesThisTurn === 2) ? j.stonesThisTurn : 0;
      const time = validateTimeMs(j.timeMs);
      if (!time.ok) return respond(res, 400, { error: 'invalid timeMs' });

      const v = validateBoard(board);
      if (!v.ok) return respond(res, 400, { error: 'invalid board: ' + v.reason });
      if (side !== 'black' && side !== 'white') return respond(res, 400, { error: 'invalid side' });

      const barr = parseBoard(board);
      if (hasSix(barr, 1) || hasSix(barr, 2)) return respond(res, 400, { error: 'game already over' });

      const line = JSON.stringify({ board, side, difficulty, stonesThisTurn, timeMs: time.timeMs });
      submit(req, res, line);
    });
    return;
  }

  respond(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  try {
    handleRequest(req, res);
  } catch (err) {
    console.error('[gateway] request handler error', err);
    respond(res, 500, { error: 'internal error' });
  }
});

// Malformed HTTP (bad request line, headers) must close the socket, not crash.
server.on('clientError', (err, socket) => {
  try {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  } catch (e) {
    try { socket.destroy(); } catch (ignored) { /* nothing left to do */ }
  }
});

server.on('error', (err) => {
  console.error('[gateway] server error', err);
});

if (require.main === module) {
  // Last-resort guards: a single bad request must never take the gateway down.
  process.on('uncaughtException', (err) => {
    console.error('[gateway] uncaught exception', err);
  });
  process.on('unhandledRejection', (err) => {
    console.error('[gateway] unhandled rejection', err);
  });

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
  clientIp,
  parseJsonObject,
  validateTimeMs,
  CONFIG: {
    HOST,
    PORT,
    BASE_PATH,
    ENGINE_PATH,
    MAX_ACTIVE_GAMES,
    GAME_SESSION_TTL_MS,
    SESSION_CLEANUP_INTERVAL_MS,
    ENGINE_TIMEOUT_MS,
    MAX_CLIENT_TIME_MS,
    MAX_REQUEST_BYTES,
    MAX_ENGINE_LINE_BYTES,
    REQUEST_RATE_WINDOW_MS,
    REQUEST_RATE_MAX,
    SESSION_RATE_WINDOW_MS,
    SESSION_RATE_MAX,
  },
};
