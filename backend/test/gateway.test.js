'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const GATEWAY = path.join(ROOT, 'backend', 'gateway.js');
const FAKE_ENGINE = path.join(ROOT, 'backend', 'test', 'fake-engine.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function requestRaw(port, method, requestPath, rawBody, cookie) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(rawBody === undefined ? '' : rawBody);
    const headers = { 'Content-Length': payload.length };
    if (payload.length > 0) headers['Content-Type'] = 'application/json';
    if (cookie) headers.Cookie = cookie;

    const req = http.request({ host: '127.0.0.1', port, method, path: requestPath, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: json, raw: data });
      });
    });
    req.on('error', reject);
    if (payload.length > 0) req.write(payload);
    req.end();
  });
}

function request(port, method, requestPath, body, cookie) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return requestRaw(port, method, requestPath, payload, cookie);
}

async function startGateway(options = {}) {
  const port = await freePort();
  const env = {
    ...process.env,
    CONNECT6_PORT: String(port),
    CONNECT6_HOST: '127.0.0.1',
    CONNECT6_BASE_PATH: '/connect6',
    CONNECT6_ENGINE: options.enginePath || FAKE_ENGINE,
    CONNECT6_MAX_ACTIVE_GAMES: String(options.maxGames || 5),
    CONNECT6_ENGINE_TIMEOUT_MS: String(options.engineTimeout || 5000),
    FAKE_ENGINE_DELAY_MS: String(options.engineDelay || 0),
    ...options.env,
  };
  const child = spawn(process.execPath, [GATEWAY], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('gateway start timeout')), 5000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('gateway listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('gateway exited before listening: ' + code));
    });
  });

  return {
    port,
    child,
    stop: () => new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      child.kill('SIGTERM');
    }),
  };
}

const EMPTY = '.'.repeat(361);

test('session reservation returns a cookie and capacity returns 503', async () => {
  const gateway = await startGateway({ maxGames: 5 });
  try {
    for (let i = 0; i < 5; i++) {
      const res = await request(gateway.port, 'GET', '/connect6/api/session');
      assert.strictEqual(res.status, 200);
      assert.match(String(res.headers['set-cookie']), /connect6_sid=/);
      assert.match(String(res.headers['set-cookie']), /HttpOnly/);
      assert.match(String(res.headers['set-cookie']), /Path=\/connect6/);
    }
    const sixth = await request(gateway.port, 'GET', '/connect6/api/session');
    assert.strictEqual(sixth.status, 503);
    assert.strictEqual(sixth.body.error, 'game capacity reached');
  } finally {
    await gateway.stop();
  }
});

test('a valid move reaches the engine and a session can move again', async () => {
  const gateway = await startGateway();
  try {
    const session = await request(gateway.port, 'GET', '/connect6/api/session');
    const cookie = String(session.headers['set-cookie']).split(';')[0];

    const first = await request(gateway.port, 'POST', '/connect6/api/move', {
      board: EMPTY,
      side: 'black',
      difficulty: 'normal',
      stonesThisTurn: 0,
    }, cookie);
    assert.strictEqual(first.status, 200);
    assert.strictEqual(first.body.moves.length, 1);

    const second = await request(gateway.port, 'POST', '/connect6/api/move', {
      board: EMPTY,
      side: 'black',
      difficulty: 'normal',
      stonesThisTurn: 0,
    }, cookie);
    assert.strictEqual(second.status, 200);
  } finally {
    await gateway.stop();
  }
});

test('invalid boards and legacy password endpoints are rejected', async () => {
  const gateway = await startGateway();
  try {
    const session = await request(gateway.port, 'GET', '/connect6/api/session');
    const cookie = String(session.headers['set-cookie']).split(';')[0];

    const invalid = await request(gateway.port, 'POST', '/connect6/api/move', {
      board: 'short',
      side: 'black',
    }, cookie);
    assert.strictEqual(invalid.status, 400);

    const verify = await request(gateway.port, 'POST', '/connect6/api/verify', {
      password: 'anything',
    });
    assert.strictEqual(verify.status, 404);
  } finally {
    await gateway.stop();
  }
});

test('two concurrent moves from one session do not exceed the slot', async () => {
  const gateway = await startGateway({ engineDelay: 150 });
  try {
    const session = await request(gateway.port, 'GET', '/connect6/api/session');
    const cookie = String(session.headers['set-cookie']).split(';')[0];
    const payload = {
      board: EMPTY,
      side: 'black',
      difficulty: 'normal',
      stonesThisTurn: 0,
    };

    const [a, b] = await Promise.all([
      request(gateway.port, 'POST', '/connect6/api/move', payload, cookie),
      request(gateway.port, 'POST', '/connect6/api/move', payload, cookie),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepStrictEqual(statuses, [200, 503]);
  } finally {
    await gateway.stop();
  }
});

test('malformed JSON and non-object payloads are rejected without crashing', async () => {
  const gateway = await startGateway();
  try {
    const session = await request(gateway.port, 'GET', '/connect6/api/session');
    const cookie = String(session.headers['set-cookie']).split(';')[0];

    for (const raw of ['null', '[]', '"x"', '42', 'true', '{', '']) {
      const res = await requestRaw(gateway.port, 'POST', '/connect6/api/move', raw, cookie);
      assert.strictEqual(res.status, 400, 'raw payload: ' + JSON.stringify(raw));
      assert.strictEqual(res.body.error, 'bad json', 'raw payload: ' + JSON.stringify(raw));
    }

    // `null` used to throw on `null.board` and kill the process.
    assert.strictEqual(gateway.child.exitCode, null, 'gateway should still be running');
    const ok = await request(gateway.port, 'POST', '/connect6/api/move', {
      board: EMPTY,
      side: 'black',
      difficulty: 'normal',
      stonesThisTurn: 0,
    }, cookie);
    assert.strictEqual(ok.status, 200);
  } finally {
    await gateway.stop();
  }
});

test('timeMs must be a bounded integer', async () => {
  const gateway = await startGateway();
  try {
    const session = await request(gateway.port, 'GET', '/connect6/api/session');
    const cookie = String(session.headers['set-cookie']).split(';')[0];
    const base = { board: EMPTY, side: 'black', difficulty: 'normal', stonesThisTurn: 0 };

    for (const timeMs of ['100', -1, 1.5, 600000, true, null, {}, [1]]) {
      const res = await request(gateway.port, 'POST', '/connect6/api/move', { ...base, timeMs }, cookie);
      assert.strictEqual(res.status, 400, 'timeMs: ' + JSON.stringify(timeMs));
      assert.strictEqual(res.body.error, 'invalid timeMs');
    }

    for (const timeMs of [0, 500]) {
      const res = await request(gateway.port, 'POST', '/connect6/api/move', { ...base, timeMs }, cookie);
      assert.strictEqual(res.status, 200, 'timeMs: ' + timeMs);
    }
  } finally {
    await gateway.stop();
  }
});

test('oversized request bodies are rejected', async () => {
  const gateway = await startGateway();
  try {
    const session = await request(gateway.port, 'GET', '/connect6/api/session');
    const cookie = String(session.headers['set-cookie']).split(';')[0];
    const res = await request(gateway.port, 'POST', '/connect6/api/move', {
      board: EMPTY,
      side: 'black',
      junk: 'x'.repeat(30000),
    }, cookie);
    assert.strictEqual(res.status, 413);
    assert.strictEqual(gateway.child.exitCode, null);
  } finally {
    await gateway.stop();
  }
});

test('new anonymous sessions are rate limited per client', async () => {
  const gateway = await startGateway({ maxGames: 5, env: { CONNECT6_SESSION_LIMIT_PER_WINDOW: '2' } });
  try {
    const first = await request(gateway.port, 'GET', '/connect6/api/session');
    assert.strictEqual(first.status, 200);
    const cookie = String(first.headers['set-cookie']).split(';')[0];

    const second = await request(gateway.port, 'GET', '/connect6/api/session');
    assert.strictEqual(second.status, 200);

    const third = await request(gateway.port, 'GET', '/connect6/api/session');
    assert.strictEqual(third.status, 429);
    assert.strictEqual(third.body.error, 'too many new sessions');
    assert.ok(Number(third.headers['retry-after']) > 0);

    // A client that already holds a session is not locked out.
    const move = await request(gateway.port, 'POST', '/connect6/api/move', {
      board: EMPTY,
      side: 'black',
      difficulty: 'normal',
      stonesThisTurn: 0,
    }, cookie);
    assert.strictEqual(move.status, 200);
  } finally {
    await gateway.stop();
  }
});

test('api requests are rate limited per client', async () => {
  const gateway = await startGateway({ env: { CONNECT6_RATE_LIMIT_PER_WINDOW: '3' } });
  try {
    const first = await request(gateway.port, 'GET', '/connect6/api/session');
    assert.strictEqual(first.status, 200);
    assert.strictEqual((await request(gateway.port, 'GET', '/connect6/api/session')).status, 200);
    assert.strictEqual((await request(gateway.port, 'GET', '/connect6/api/session')).status, 200);
    const limited = await request(gateway.port, 'GET', '/connect6/api/session');
    assert.strictEqual(limited.status, 429);
    assert.strictEqual(limited.body.error, 'too many requests');
  } finally {
    await gateway.stop();
  }
});

test('a timed-out engine request returns 504 and leaves the gateway alive', async () => {
  const gateway = await startGateway({ engineDelay: 2000, engineTimeout: 200 });
  try {
    const session = await request(gateway.port, 'GET', '/connect6/api/session');
    const cookie = String(session.headers['set-cookie']).split(';')[0];
    const res = await request(gateway.port, 'POST', '/connect6/api/move', {
      board: EMPTY,
      side: 'black',
      difficulty: 'normal',
      stonesThisTurn: 0,
    }, cookie);
    assert.strictEqual(res.status, 504);
    assert.strictEqual(res.body.error, 'engine timeout');
    assert.strictEqual(gateway.child.exitCode, null);
  } finally {
    await gateway.stop();
  }
});

test('unbounded engine output is capped', async () => {
  const gateway = await startGateway({
    env: { FAKE_ENGINE_MODE: 'flood', CONNECT6_MAX_ENGINE_LINE_BYTES: '4096' },
  });
  try {
    const session = await request(gateway.port, 'GET', '/connect6/api/session');
    const cookie = String(session.headers['set-cookie']).split(';')[0];
    const res = await request(gateway.port, 'POST', '/connect6/api/move', {
      board: EMPTY,
      side: 'black',
      difficulty: 'normal',
      stonesThisTurn: 0,
    }, cookie);
    assert.ok([502, 503].includes(res.status), 'unexpected status ' + res.status);
    assert.strictEqual(gateway.child.exitCode, null);
  } finally {
    await gateway.stop();
  }
});

test('a crashing engine does not take the gateway down', async () => {
  const gateway = await startGateway({ env: { FAKE_ENGINE_MODE: 'crash' } });
  try {
    const session = await request(gateway.port, 'GET', '/connect6/api/session');
    const cookie = String(session.headers['set-cookie']).split(';')[0];
    const res = await request(gateway.port, 'POST', '/connect6/api/move', {
      board: EMPTY,
      side: 'black',
      difficulty: 'normal',
      stonesThisTurn: 0,
    }, cookie);
    assert.strictEqual(res.status, 503);
    assert.strictEqual(gateway.child.exitCode, null);
  } finally {
    await gateway.stop();
  }
});

test('a missing engine binary returns 503 instead of crashing', async () => {
  const gateway = await startGateway({ enginePath: path.join(ROOT, 'backend', 'does-not-exist') });
  try {
    const session = await request(gateway.port, 'GET', '/connect6/api/session');
    const cookie = String(session.headers['set-cookie']).split(';')[0];
    const res = await request(gateway.port, 'POST', '/connect6/api/move', {
      board: EMPTY,
      side: 'black',
      difficulty: 'normal',
      stonesThisTurn: 0,
    }, cookie);
    assert.ok([503, 504].includes(res.status), 'unexpected status ' + res.status);
    assert.strictEqual(gateway.child.exitCode, null);
  } finally {
    await gateway.stop();
  }
});

test('malformed HTTP requests do not crash the gateway', async () => {
  const gateway = await startGateway();
  try {
    await new Promise((resolve) => {
      const socket = net.connect(gateway.port, '127.0.0.1', () => {
        socket.write('GET /connect6/api/session HTTP/1.1\r\nHost: x\r\nBad Header\r\n\r\n');
      });
      socket.on('close', resolve);
      socket.on('error', resolve);
      setTimeout(() => { socket.destroy(); resolve(); }, 2000).unref();
    });
    assert.strictEqual(gateway.child.exitCode, null);
    const alive = await request(gateway.port, 'GET', '/connect6/api/session');
    assert.strictEqual(alive.status, 200);
  } finally {
    await gateway.stop();
  }
});

test('a non-object engine response is reported as a parse error', async () => {
  const gateway = await startGateway({ env: { FAKE_ENGINE_MODE: 'null-response' } });
  try {
    const session = await request(gateway.port, 'GET', '/connect6/api/session');
    const cookie = String(session.headers['set-cookie']).split(';')[0];
    const res = await request(gateway.port, 'POST', '/connect6/api/move', {
      board: EMPTY,
      side: 'black',
      difficulty: 'normal',
      stonesThisTurn: 0,
    }, cookie);
    assert.strictEqual(res.status, 500);
    assert.strictEqual(res.body.error, 'engine parse error');
    assert.strictEqual(gateway.child.exitCode, null);
  } finally {
    await gateway.stop();
  }
});
