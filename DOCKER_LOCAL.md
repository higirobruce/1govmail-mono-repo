# 1Gov Mail — Local Docker Deployment Guide

> Run the full production stack locally — no TLS, no domain name required.
> Everything is accessible at `http://localhost`.
> For production deployment with automatic HTTPS, see [DOCKER_DEPLOY.md](DOCKER_DEPLOY.md).

---

## Files Used

| File | Purpose |
|---|---|
| `docker-compose.local.yml` | Local stack (HTTP only, postgres/redis ports exposed to host) |
| `nginx/nginx.local.conf` | HTTP-only nginx config for `localhost` |
| `.env.local.example` | Pre-filled local env vars — copy and use as-is |

---

## Quick Start

```bash
# 1. Copy the env file (defaults work out of the box)
cp .env.local.example .env.local

# 2. Build and start the stack
docker compose -f docker-compose.local.yml --env-file .env.local up -d --build

# 3. Open the app
open http://localhost
```

---

## What's Running

| Service | Host access | Purpose |
|---|---|---|
| Nginx | `http://localhost` | Reverse proxy — single entry point |
| Next.js web | via Nginx `/` | Frontend |
| NestJS API | via Nginx `/api/` | REST API |
| Hocuspocus | via Nginx `/collab` (WS) | Docs / Tasks real-time collab |
| PostgreSQL | `localhost:5432` | Database (exposed for DB tools) |
| Redis | `localhost:6379` | Cache (exposed for inspection) |

### URL map

| URL | What it hits |
|---|---|
| `http://localhost` | Next.js web app |
| `http://localhost/api/` | NestJS REST API |
| `ws://localhost/collab` | Hocuspocus WebSocket |
| `localhost:5432` | PostgreSQL (direct, for TablePlus / psql) |
| `localhost:6379` | Redis (direct, for redis-cli) |

---

## Startup Order

```
postgres (healthy) ──▶ migrate (exits 0) ──▶ api ──┐
redis    (healthy) ─────────────────────────────────▶ api ──▶ nginx
                                                       web ──▶ nginx
```

The `migrate` service runs `prisma migrate deploy` once and exits. The `api` container waits for it to complete successfully before starting.

---

## Useful Commands

### View logs

```bash
# All services
docker compose -f docker-compose.local.yml --env-file .env.local logs -f

# Single service
docker compose -f docker-compose.local.yml --env-file .env.local logs -f api
docker compose -f docker-compose.local.yml --env-file .env.local logs -f migrate
```

### Restart a service

```bash
docker compose -f docker-compose.local.yml --env-file .env.local restart api
```

### Stop everything

```bash
docker compose -f docker-compose.local.yml --env-file .env.local down
```

### Stop and wipe all data (clean slate)

```bash
docker compose -f docker-compose.local.yml --env-file .env.local down -v
```

### Connect to PostgreSQL directly

```bash
# Via Docker exec
docker compose -f docker-compose.local.yml --env-file .env.local exec postgres psql -U govmail -d govmail

# Via psql on host (port 5432 is exposed)
# NOTE: stop any locally-running PostgreSQL first to avoid port conflicts
PGPASSWORD=govmail psql -h 127.0.0.1 -U govmail -d govmail
```

### Run migrations manually

```bash
docker compose -f docker-compose.local.yml --env-file .env.local run --rm migrate
```

### Rebuild after code changes

```bash
# Rebuild all images and recreate containers
docker compose -f docker-compose.local.yml --env-file .env.local up -d --build

# Rebuild a single service (use --no-cache if a Dockerfile metadata-only change isn't picked up)
docker compose -f docker-compose.local.yml --env-file .env.local build --no-cache web
docker compose -f docker-compose.local.yml --env-file .env.local up -d web
```

> **Note:** `NEXT_PUBLIC_*` vars are baked into the JS bundle at build time. Rebuild the `web` image after any frontend URL change.

---

## Troubleshooting

### `migrate` service exits with code 1

Get the error:
```bash
docker compose -f docker-compose.local.yml --env-file .env.local logs migrate
```

**Common cause:** Port 5432 is in use by a locally-running PostgreSQL instance. The migrate service connects to Docker's postgres via `postgres:5432` (internal), but if you try to run `prisma migrate dev` from the host, it may hit the wrong instance.

Fix: Stop your local postgres before running host-side prisma commands:
```bash
# macOS (Homebrew)
brew services stop postgresql@<version>
# or
pg_ctl -D /usr/local/var/postgresql stop
```

### `web` container exits: `Cannot find module '/app/server.js'`

Docker used a cached image that predates the CMD fix. Force a rebuild:
```bash
docker compose -f docker-compose.local.yml --env-file .env.local build --no-cache web
docker compose -f docker-compose.local.yml --env-file .env.local up -d web
```

### Regenerating migrations after schema changes

```bash
# 1. Start only postgres
docker compose -f docker-compose.local.yml --env-file .env.local up -d postgres

# 2. Stop any local postgres to free port 5432
brew services stop postgresql@<version>

# 3. Generate migration from apps/api
cd apps/api
DATABASE_URL="postgresql://govmail:govmail@localhost:5432/govmail" npx prisma migrate dev --name <migration_name>

# 4. Rebuild and restart the full stack
docker compose -f docker-compose.local.yml --env-file .env.local up -d --build
```

---

## Differences from Production

| | Local (`docker-compose.local.yml`) | Production (`docker-compose.yml`) |
|---|---|---|
| TLS | None (HTTP only) | Automatic (https-portal + Let's Encrypt) |
| HTTP→HTTPS redirect | No | Yes (https-portal) |
| Domain | `localhost` | `mail.yourdomain.gov` |
| SSL proxy | — | `steveltn/https-portal:1` |
| Nginx config | `nginx/nginx.local.conf` | `nginx/nginx.conf` |
| Postgres password | `govmail` | Strong random (`openssl rand -hex 32`) |
| JWT secret | `local_dev_secret_...` | Strong random (`openssl rand -hex 32`) |
| JWT expiry | `24h` | `8h` |
| DB port exposed | Yes (`5432`) | No |
| Redis port exposed | Yes (`6379`) | No |
