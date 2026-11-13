#!/usr/bin/env node
// Deterministic fake engine used only by the gateway integration tests.
// It returns legal-shaped moves without running the real AI search.
'use strict';

const delay = Number.parseInt(process.env.FAKE_ENGINE_DELAY_MS || '0', 10) || 0;
const mode = process.env.FAKE_ENGINE_MODE || 'normal';
let buffer = '';

function respond(line) {
  if (mode === 'crash') {
    process.exit(1);
  }
  if (mode === 'flood') {
    // Never terminate the line; the gateway must bound its stdout buffer.
    process.stdout.write('x'.repeat(65536));
    return;
  }
  if (mode === 'null-response') {
    process.stdout.write('null\n');
    return;
  }

  let request;
  try {
    request = JSON.parse(line);
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: 'bad json' }) + '\n');
    return;
  }

  const board = String(request.board || '');
  const wanted = request.side === 'black' ? 1 : 2;
  const moves = [];
  for (let i = 0; i < board.length && moves.length < wanted; i++) {
    if (board[i] === '.' && i !== 180) moves.push([i % 19, Math.floor(i / 19)]);
  }

  const respondNow = () => process.stdout.write(JSON.stringify({ moves, elapsedMs: 1 }) + '\n');
  if (delay > 0) setTimeout(respondNow, delay);
  else respondNow();
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim()) respond(line);
  }
});
