# Connect6

A self-contained Connect6 (六子棋) web game: a C++17 AI engine, a small Node.js
gateway, and a dependency-free Canvas frontend.

- 19×19 board, standard Connect6 rules: Black opens with one stone, then each
  side places two stones per turn, and six in a row wins.
- Anonymous game slots. At most **5 games** can occupy a slot at the same time.
- A slot expires after 30 minutes. The gateway cleans expired, idle slots every
  30 minutes.
- When no slot is available, the API returns **HTTP 503** and the frontend shows
  a capacity page.
- No password gate. The old private-password flow has been removed.

## Architecture

```text
browser
  └── frontend/index.html          static Canvas UI
        └── /api/move, /api/session
              └── backend/gateway.js   Node.js, no npm dependencies
                    └── backend/engine  native C++17 AI (line protocol)
```

The gateway is the only component that talks to the engine. It validates the
board, limits active slots, serializes engine calls, and returns JSON.

## Requirements

- Node.js 18+ (tested with Node 24)
- g++ with C++17 support
- Python 3 for the optional engine verification scripts and shell tests

No npm packages are required.

## Build the engine

```bash
g++ -O2 -o backend/engine engine/engine.cpp
```

Or:

```bash
npm run build:engine
```

## Run the gateway

```bash
CONNECT6_ENGINE=./backend/engine node backend/gateway.js
```

Defaults:

| Variable | Default | Meaning |
|---|---|---|
| `CONNECT6_HOST` | `127.0.0.1` | Listen address |
| `CONNECT6_PORT` | `18090` | Listen port |
| `CONNECT6_BASE_PATH` | `/connect6` | URL prefix and cookie path |
| `CONNECT6_ENGINE` | `backend/engine` | Engine binary |
| `CONNECT6_MAX_ACTIVE_GAMES` | `5` | Concurrent game slots |
| `CONNECT6_SESSION_TTL_MS` | `1800000` | Slot lifetime (30 min) |
| `CONNECT6_CLEANUP_INTERVAL_MS` | `1800000` | Cleanup interval |
| `CONNECT6_ENGINE_TIMEOUT_MS` | `30000` | Kill a hung engine request |

Copy `.env.example` if you prefer a file:

```bash
cp .env.example .env
set -a; . ./.env; set +a
```

## Frontend

The frontend is a single HTML file and needs no build step.

- `/connect6/game/` serves `frontend/index.html`.
- The page derives the API prefix from its own URL, so it works at
  `/connect6/game/`, `/game/`, or another prefix without editing HTML.
- You can override the API prefix before the main script runs:

```html
<script>window.CONNECT6_API_BASE = "/connect6/api";</script>
```

## Tests

Engine regression and tactics:

```bash
npm run build:engine
bash engine/tests.sh ./backend/engine
python3 engine/verify.py
python3 engine/selftest.py
```

Gateway integration tests (spawns a fake engine and exercises slot limits,
503 responses, invalid boards, the removed password endpoint, and concurrent
requests):

```bash
npm run test:gateway
```

All tests:

```bash
npm test
```

The gateway tests do not touch a production server.

## Concurrency behaviour

- Each browser gets an HttpOnly `connect6_sid` cookie when it reserves a slot.
- `MAX_ACTIVE_GAMES` limits the number of live slots.
- Only one engine request per slot may be in flight; a second concurrent move
  from the same slot gets 503.
- The engine is a single process and requests are serialized. A queue length of
  `MAX_ACTIVE_GAMES` is enforced as a second guard.
- If the engine crashes, exits, or exceeds the engine timeout, the current
  request is failed and its slot is released instead of leaking.
- A slot that expires while a request is in flight is kept until the request
  finishes, then removed.
- A slot created for a request that is rejected at the capacity check is
  removed immediately.

## Deploy

A minimal nginx-based deployment:

1. Build the engine and start the gateway:

   ```bash
   g++ -O2 -o backend/engine engine/engine.cpp
   bash deploy/start-gateway.sh
   ```

2. Copy the frontend:

   ```bash
   CONNECT6_WEB_ROOT=/var/www/connect6/game bash deploy/deploy-static.sh
   ```

3. Add `deploy/nginx-connect6.conf` to your server block. It proxies
   `/connect6/api/` to `127.0.0.1:18090` and serves
   `/connect6/game/` from `/var/www/connect6/game/`.

4. Smoke test:

   ```bash
   CONNECT6_URL=https://example.com/connect6 bash deploy/acceptance.sh
   ```

The scripts do not assume a particular Unix user, home directory, domain, or
server layout. Set `CONNECT6_DIR`, `CONNECT6_PID_FILE`, `CONNECT6_LOG` and
`CONNECT6_WEB_ROOT` when your paths differ.

### systemd (optional)

```ini
[Unit]
Description=Connect6 gateway
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/connect6
Environment=CONNECT6_ENGINE=/opt/connect6/backend/engine
ExecStart=/usr/bin/node /opt/connect6/backend/gateway.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## AI difficulty

| Difficulty | Candidate points K | Time budget |
|---|---|---|
| easy | 8 | ~90 ms (with randomness) |
| normal | 14 | ~400 ms |
| hard | 20 | ~1.6 s |
| expert | 28 | ~4.5 s |

The engine uses Negamax + alpha-beta, iterative deepening, a transposition
table, Zobrist hashing, candidate pruning, pattern evaluation, and two-stone
move combinations.

## Security notes

- No password is stored or checked. The old `CONNECT6_PASSWORD` variable and
  `/api/verify` endpoint are intentionally gone.
- Slots are anonymous. If you need abuse protection, add rate limiting or a
  reverse-proxy access policy; do not reintroduce a hard-coded shared password.
- The gateway binds to `127.0.0.1` by default. Expose it through nginx or
  another reverse proxy.
- Cookies are `HttpOnly` and `SameSite=Lax`; `Secure` is added when
  `X-Forwarded-Proto: https` is present.

## License

MIT. See [LICENSE](LICENSE).
