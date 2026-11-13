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

function request(port, method, requestPath, body, cookie) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = {};
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
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
    if (payload) req.write(payload);
    req.end();
  });
}

async function startGateway(options = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [GATEWAY], {
    cwd: ROOT,
    env: {
      ...process.env,
      CONNECT6_PORT: String(port),
      CONNECT6_HOST: '127.0.0.1',
      CONNECT6_BASE_PATH: '/connect6',
      CONNECT6_ENGINE: FAKE_ENGINE,
      CONNECT6_MAX_ACTIVE_GAMES: String(options.maxGames || 5),
      CONNECT6_ENGINE_TIMEOUT_MS: '5000',
      FAKE_ENGINE_DELAY_MS: String(options.engineDelay || 0),
    },
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
