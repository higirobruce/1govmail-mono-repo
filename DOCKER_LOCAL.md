# 1Gov Mail — Local Docker Deployment Guide

> For running the full production stack locally — no TLS certificates, no domain name required.
> Everything is accessible at `http://localhost`.
> For production deployment with SSL, see [DOCKER_DEPLOY.md](DOCKER_DEPLOY.md).

---

## Files Used

| File | Purpose |
|---|---|
| `docker-compose.local.yml` | Local stack definition (HTTP only, ports exposed to host) |
| `nginx/nginx.local.conf` | HTTP-only Nginx config for `localhost` |
| `.env.local.example` | Pre-filled local env vars — copy and use as-is |

---

## Quick Start

```bash
# 1. Copy the env file (defaults work out of the box)
cp .env.local.example .env.local

# 2. Build images
docker compose -f docker-compose.local.yml --env-file .env.local build

# 3. Start the stack
docker compose -f docker-compose.local.yml --env-file .env.local up -d

# 4. Open the app
open http://localhost
```

That's it. No certs, no domain config.

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
postgres (healthy) ──▶ migrate (runs & exits) ──▶ api ──┐
redis    (healthy) ────────────────────────────────────────▶ api ──▶ nginx
                                                            web  ──▶ nginx
```

The `migrate` service runs `prisma migrate deploy` once and exits. The `api` container waits for it to complete before starting.

---

## Useful Commands

### View logs

```bash
# All services
docker compose -f docker-compose.local.yml logs -f

# Single service
docker compose -f docker-compose.local.yml logs -f api
docker compose -f docker-compose.local.yml logs -f migrate
```

### Restart a service

```bash
docker compose -f docker-compose.local.yml restart api
```

### Stop everything

```bash
docker compose -f docker-compose.local.yml down
```

### Stop and wipe all data (clean slate)

```bash
docker compose -f docker-compose.local.yml down -v
```

### Connect to PostgreSQL directly

```bash
# Via Docker
docker compose -f docker-compose.local.yml exec postgres psql -U govmail -d govmail

# Via psql on host (port is exposed)
psql -h localhost -U govmail -d govmail
# password: govmail
```

### Run migrations manually

```bash
docker compose -f docker-compose.local.yml run --rm migrate
```

### Rebuild after code changes

```bash
# Rebuild all images and recreate containers
docker compose -f docker-compose.local.yml up -d --build

# Rebuild a single service
docker compose -f docker-compose.local.yml up -d --build api
```

> **Note:** If you change any frontend code, the `web` image must be rebuilt because `NEXT_PUBLIC_*` vars are baked into the JS bundle at build time.

---

## Differences from Production

| | Local (`docker-compose.local.yml`) | Production (`docker-compose.yml`) |
|---|---|---|
| TLS | None (HTTP) | Required (HTTPS) |
| Domain | `localhost` | `mail.yourdomain.gov` |
| Postgres password | `govmail` | Strong random password |
| JWT secret | `local_dev_secret_...` | `openssl rand -hex 32` |
| JWT expiry | `24h` | `8h` |
| DB port exposed | Yes (`5432`) | No |
| Redis port exposed | Yes (`6379`) | No |
| Nginx config | `nginx/nginx.local.conf` | `nginx/nginx.conf` |
