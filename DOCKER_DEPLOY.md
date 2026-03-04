# 1Gov Mail — Docker Deployment Guide (200+ Users)

> Covers the centralized, containerized deployment of 1Gov Mail for organizations with 200+ users.
> The desktop app (standalone/SQLite) is unaffected — only the server-side stack is described here.

---

## What Was Changed

### Code changes (SQLite → PostgreSQL)

| File | Change |
|---|---|
| `apps/api/prisma/schema.prisma` | provider `sqlite` → `postgresql`, added `url = env("DATABASE_URL")` |
| `apps/api/src/prisma/prisma.service.ts` | Removed `better-sqlite3` adapter — `PrismaClient()` reads `DATABASE_URL` directly |
| `apps/api/src/collab/collab.server.ts` | Removed `makePrisma()` with sqlite adapter — uses standard `PrismaClient()` |

### New files created

| File | Purpose |
|---|---|
| `apps/api/Dockerfile` | 3-stage build: install → compile → minimal production image |
| `apps/web/Dockerfile` | 2-stage build: Next.js standalone output |
| `docker-compose.yml` | Full stack: postgres, redis, migrate (one-off), api, web, nginx |
| `nginx/nginx.conf` | TLS termination, `/api/` → NestJS, `/collab` → Hocuspocus WS, `/` → Next.js |
| `.env.example` | All required env vars with instructions |
| `.dockerignore` | Excludes desktop app, node_modules, build artifacts from Docker context |

---

## Stack Overview

```
                         ┌─────────────────────────────────────┐
                         │           Central Backend             │
  ┌──────────┐           │  ┌──────────┐    ┌───────────────┐  │
  │ Browser  │──HTTPS───▶│  │ Next.js  │    │  NestJS API   │  │
  └──────────┘           │  │  :3000   │    │  :3001/api    │  │
                         │  └──────────┘    └───────┬───────┘  │
  ┌──────────┐           │                          │           │
  │ Desktop  │──HTTPS───▶│  ┌──────────────────┐    │           │
  │ Electron │──WSS─────▶│  │ Hocuspocus WS    │    │           │
  └──────────┘           │  │  :1234 (collab)  │    │           │
                         │  └──────────────────┘    │           │
                         │                    ┌──────▼──────┐   │
                         │                    │ PostgreSQL  │   │
                         │                    └─────────────┘   │
                         └─────────────────────────────────────┘
                                     ▲
                               Nginx (80/443)
                         TLS · /api · /collab · /
```

All traffic enters through **Nginx only**. The `api` and `web` containers are not exposed to the host.

---

## Prerequisites

- Docker Engine 26+ and Docker Compose v2
- A domain name with DNS pointing to your server
- TLS certificates (Let's Encrypt via `certbot`, or your internal CA)
- Server: minimum **4 vCPU / 8 GB RAM** for 200 concurrent users

---

## First-Time Deployment

### 1. Clone and enter the repo

```bash
git clone <your-repo-url>
cd email-client
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in every value:

```env
# PostgreSQL
POSTGRES_PASSWORD=use_a_strong_random_password

# Generate with: openssl rand -hex 32
JWT_SECRET=your_256bit_random_secret
JWT_EXPIRES_IN=8h

# Public URL of the frontend (used for CORS)
FRONTEND_URL=https://mail.yourdomain.gov

# Baked into the Next.js JS bundle at build time — must match your domain
NEXT_PUBLIC_API_URL=https://mail.yourdomain.gov/api
NEXT_PUBLIC_COLLAB_WS_URL=wss://mail.yourdomain.gov/collab
```

> **Important:** `NEXT_PUBLIC_*` variables are embedded into the JavaScript bundle when the web image is built. If you change your domain, you must rebuild the web image.

### 3. Place TLS certificates

```bash
# Certificates must be named exactly as shown
cp /etc/letsencrypt/live/mail.yourdomain.gov/fullchain.pem nginx/certs/
cp /etc/letsencrypt/live/mail.yourdomain.gov/privkey.pem   nginx/certs/
```

For Let's Encrypt, you can automate renewal with:

```bash
certbot certonly --standalone -d mail.yourdomain.gov
# Then copy renewed certs and: docker compose restart nginx
```

### 4. Build images

```bash
docker compose build \
  --build-arg NEXT_PUBLIC_API_URL=https://mail.yourdomain.gov/api \
  --build-arg NEXT_PUBLIC_COLLAB_WS_URL=wss://mail.yourdomain.gov/collab
```

> The build args must be passed here because `NEXT_PUBLIC_*` values are baked into the compiled JavaScript at build time — they cannot be injected at runtime via environment variables.

### 5. Start the stack

```bash
docker compose up -d
```

Docker Compose starts services in this order:

```
postgres (healthy) ──▶ migrate (runs & exits) ──▶ api ──┐
redis    (healthy) ────────────────────────────────────────▶ api ──▶ nginx
                                                            web  ──▶ nginx
```

The `migrate` service runs `prisma migrate deploy` once and exits. The `api` service will not start until migrations complete successfully.

### 6. Verify

```bash
# Confirm migrations ran without errors
docker compose logs migrate

# Watch API startup
docker compose logs -f api

# Check all services are running
docker compose ps
```

Then open `https://mail.yourdomain.gov` in a browser.

---

## Routine Operations

### View logs

```bash
docker compose logs -f api       # NestJS API + Hocuspocus
docker compose logs -f web       # Next.js
docker compose logs -f postgres
```

### Restart a single service

```bash
docker compose restart api
```

### Deploy an update

```bash
git pull

# Rebuild images with build args
docker compose build \
  --build-arg NEXT_PUBLIC_API_URL=https://mail.yourdomain.gov/api \
  --build-arg NEXT_PUBLIC_COLLAB_WS_URL=wss://mail.yourdomain.gov/collab

# Recreate containers (migrate runs automatically before api starts)
docker compose up -d
```

### Run a database migration manually

```bash
docker compose run --rm migrate
```

### Open a psql shell

```bash
docker compose exec postgres psql -U govmail -d govmail
```

### Backup the database

```bash
docker compose exec postgres pg_dump -U govmail govmail > backup_$(date +%Y%m%d_%H%M%S).sql
```

Schedule this daily with cron:

```cron
0 2 * * * cd /opt/email-client && docker compose exec -T postgres pg_dump -U govmail govmail > /backups/govmail_$(date +\%Y\%m\%d).sql
```

### Rotate the JWT secret

```bash
# 1. Generate a new secret
openssl rand -hex 32

# 2. Update .env
JWT_SECRET=new_secret_here

# 3. Restart the API — all existing sessions are immediately invalidated
docker compose up -d api
```

---

## Nginx Configuration Notes

Traffic routing in `nginx/nginx.conf`:

| Path | Upstream | Notes |
|---|---|---|
| `/collab` | `api:1234` (WebSocket) | Hocuspocus real-time collab; `proxy_read_timeout 86400s` keeps WS alive |
| `/api/` | `api:3001` (HTTP) | NestJS REST API |
| `/` | `web:3000` (HTTP) | Next.js frontend |

The `/collab` location **must** appear before `/` in the config — it already does in `nginx/nginx.conf`.

---

## Key Design Notes

- **`migrate` one-off service** — runs `prisma migrate deploy` and exits with code 0 on success. The `api` service has `depends_on: migrate: condition: service_completed_successfully`, so it will never start against a stale schema.
- **Ports not exposed to host** — `api` (3001, 1234) and `web` (3000) use `expose`, not `ports`. Only Nginx exposes 80/443 to the internet.
- **NEXT_PUBLIC_* are build-time** — changing your domain requires `docker compose build` + `docker compose up -d web`.
- **Desktop app unchanged** — the standalone Electron build bundles its own NestJS + SQLite and is unaffected by this deployment.
- **Redis** — included in the stack for future use (Hocuspocus pub/sub for multi-instance collab, rate limiting, Bull queues). No code changes are needed to use it when you scale out.

---

## Scaling Beyond 200 Users

| Bottleneck | Solution |
|---|---|
| API CPU | Run 2+ `api` replicas; add `@hocuspocus/extension-redis` for collab pub/sub across instances |
| PostgreSQL connections | Add [PgBouncer](https://www.pgbouncer.org/) in front of Postgres |
| WebSocket connections | Each Hocuspocus instance handles ~500–1000 WS connections; scale with Redis adapter |
| File attachments | Move to S3/MinIO; add `ATTACHMENT_STORAGE` env var + storage service in NestJS |
| Next.js | Stateless; scale freely behind Nginx upstream |
