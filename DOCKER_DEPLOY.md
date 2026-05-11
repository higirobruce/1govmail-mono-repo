# 1Gov Mail — Docker Deployment Guide (Production)

> Centralized, containerized deployment of 1Gov Mail for organizations with 200+ users.
> The desktop app (Electron/SQLite) is unaffected — only the server-side stack is described here.
> For local testing without a domain or TLS, see [DOCKER_LOCAL.md](DOCKER_LOCAL.md).

---

## Architecture

```
  Internet
     │
     ▼
┌─────────────────────────────────────────────────┐
│  https-portal  (ports 80 + 443)                 │
│  Let's Encrypt auto-cert · HTTP→HTTPS redirect  │
└────────────────────┬────────────────────────────┘
                     │ HTTP (internal)
                     ▼
             ┌───────────────┐
             │  nginx :80    │  internal routing only
             └──┬─────┬──┬───┘
         /api/  │     │  │ /collab (WS)
                │  /  │  └──────────▶ api:1234  (Hocuspocus)
                │     └──────────────▶ web:3000  (Next.js)
                └────────────────────▶ api:3001  (NestJS REST)
                                             │
                                    ┌────────▼────────┐
                                    │   PostgreSQL     │
                                    └─────────────────┘
```

All inbound traffic enters through **https-portal only**. The `nginx`, `api`, and `web` containers are not exposed to the host.

---

## What Was Changed (SQLite → PostgreSQL)

| File | Change |
|---|---|
| `apps/api/prisma/schema.prisma` | provider `sqlite` → `postgresql`; removed `url` (Prisma 7 uses driver adapter pattern) |
| `apps/api/prisma/migrations/` | All SQLite migration files deleted; replaced with a single `0001_init` PostgreSQL migration |
| `apps/api/prisma/migrations/migration_lock.toml` | provider `sqlite` → `postgresql` |
| `apps/api/prisma.config.ts` | `datasource.url` for CLI; adapter handled at runtime |
| `apps/api/src/prisma/prisma.service.ts` | `better-sqlite3` adapter → `@prisma/adapter-pg` |
| `apps/api/src/collab/collab.server.ts` | `better-sqlite3` adapter → `@prisma/adapter-pg` |
| `apps/api/package.json` | Removed `better-sqlite3`, `@prisma/adapter-better-sqlite3`; added `@prisma/adapter-pg`, `pg` |
| `.npmrc` | Added `shamefully-hoist=true` (required for Turbopack + Docker pnpm resolution) |

---

## Files

| File | Purpose |
|---|---|
| `apps/api/Dockerfile` | 3-stage build: install → compile + prisma generate → production image |
| `apps/web/Dockerfile` | 2-stage build: Next.js standalone output |
| `docker-compose.yml` | Production stack: postgres, redis, migrate, api, web, nginx, https-portal |
| `nginx/nginx.conf` | Internal HTTP router: `/api/` → NestJS, `/collab` → Hocuspocus WS, `/` → Next.js |
| `.env.example` | All required env vars with instructions |
| `.dockerignore` | Excludes desktop app, node_modules, build artifacts, .env files |

---

## Prerequisites

- Docker Engine 26+ and Docker Compose v2
- A domain with a DNS A/AAAA record pointing to this server on ports 80 and 443
- Server: minimum **4 vCPU / 8 GB RAM** for 200 concurrent users
- **No manual TLS certificate setup** — https-portal handles Let's Encrypt automatically

---

## First-Time Deployment

### 1. Clone the repo

```bash
git clone <your-repo-url>
cd email-client
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` and fill in all values:

```env
# Your public domain — DNS must point to this server
DOMAIN=mail.yourdomain.gov

# 'production' for real LE certs; 'staging' to test without rate limits
HTTPS_STAGE=production

# PostgreSQL — generate with: openssl rand -hex 32
POSTGRES_PASSWORD=use_a_strong_random_password

# JWT — generate with: openssl rand -hex 32
JWT_SECRET=your_256bit_random_secret
JWT_EXPIRES_IN=8h

# Must match DOMAIN above
FRONTEND_URL=https://mail.yourdomain.gov
NEXT_PUBLIC_API_URL=https://mail.yourdomain.gov/api
NEXT_PUBLIC_COLLAB_WS_URL=wss://mail.yourdomain.gov/collab
```

> **`NEXT_PUBLIC_*` are baked into the JavaScript bundle at build time.** If you change your domain, you must rebuild the `web` image.

### 3. Build images

```bash
docker compose build
```

The `web` image reads `NEXT_PUBLIC_*` from `.env` via the `args` block in `docker-compose.yml` — no extra `--build-arg` flags needed.

### 4. Start the stack

```bash
docker compose up -d
```

Startup order is enforced by health checks and `depends_on`:

```
postgres (healthy) ──▶ migrate (exits 0) ──▶ api ──┐
redis    (healthy) ─────────────────────────────────▶ api ──▶ nginx ──▶ https-portal
                                                       web ──▶ nginx
```

https-portal will obtain a Let's Encrypt certificate on first boot. This requires ports 80 and 443 to be reachable from the internet.

### 5. Verify

```bash
# Confirm migrations completed cleanly
docker compose logs migrate

# Watch API startup
docker compose logs -f api

# Check all services
docker compose ps
```

Open `https://mail.yourdomain.gov` in a browser.

---

## Routine Operations

### View logs

```bash
docker compose logs -f api          # NestJS API + Hocuspocus
docker compose logs -f web          # Next.js
docker compose logs -f https-portal # TLS certificate activity
docker compose logs -f postgres
```

### Restart a service

```bash
docker compose restart api
```

### Deploy an update

```bash
git pull

# Rebuild images (web image re-bakes NEXT_PUBLIC_* from .env)
docker compose build

# Recreate containers — migrate runs automatically before api starts
docker compose up -d
```

### Run migrations manually

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

Schedule daily with cron:

```cron
0 2 * * * cd /opt/email-client && docker compose exec -T postgres pg_dump -U govmail govmail > /backups/govmail_$(date +\%Y\%m\%d).sql
```

### Rotate the JWT secret

```bash
# 1. Generate a new secret
openssl rand -hex 32

# 2. Update JWT_SECRET in .env

# 3. Restart the API — all existing sessions are immediately invalidated
docker compose up -d api
```

### TLS certificate renewal

Certificates are renewed automatically by https-portal. No manual action is needed.

To force a renewal or inspect certificate status:

```bash
docker compose logs https-portal
docker compose restart https-portal
```

---

## Nginx Routing

`nginx/nginx.conf` routes traffic received from https-portal (HTTP, internal):

| Path | Upstream | Notes |
|---|---|---|
| `/collab` | `api:1234` (WebSocket) | Hocuspocus real-time collab; `proxy_read_timeout 86400s` |
| `/api/` | `api:3001` | NestJS REST API |
| `/` | `web:3000` | Next.js frontend (catch-all) |

`/collab` must appear before `/` in the config — it already does.

---

## Key Design Notes

- **https-portal** — handles ports 80/443, HTTP→HTTPS redirect, Let's Encrypt issuance and auto-renewal. Use `HTTPS_STAGE=staging` to test without hitting LE rate limits.
- **nginx (internal)** — HTTP-only reverse proxy, not port-exposed. Receives decrypted traffic from https-portal and routes it to the correct service.
- **`migrate` one-off service** — runs `prisma migrate deploy` and exits 0. The `api` service has `depends_on: condition: service_completed_successfully`, so it never starts against a stale schema.
- **Ports not exposed to host** — `api` (3001, 1234) and `web` (3000) use `expose`, not `ports`. Only https-portal touches the host network.
- **`NEXT_PUBLIC_*` are build-time** — changing the domain requires `docker compose build && docker compose up -d web`.
- **Prisma 7 driver adapter** — `PrismaClient` uses `@prisma/adapter-pg` at runtime; the `prisma.config.ts` `datasource.url` is used only by the CLI (`migrate`, `generate`).
- **Desktop app unchanged** — the Electron build bundles its own NestJS + SQLite and is unaffected by this deployment.
- **Redis** — included for future use (Hocuspocus pub/sub for multi-instance collab, Bull queues). No code changes needed to use it when scaling out.

---

## Scaling Beyond 200 Users

| Bottleneck | Solution |
|---|---|
| API CPU | Run 2+ `api` replicas; add `@hocuspocus/extension-redis` for collab pub/sub across instances |
| PostgreSQL connections | Add [PgBouncer](https://www.pgbouncer.org/) in front of Postgres |
| WebSocket connections | Each Hocuspocus instance handles ~500–1000 WS connections; scale with Redis adapter |
| File attachments | Move to S3/MinIO; add `ATTACHMENT_STORAGE` env var + storage service in NestJS |
| Next.js | Stateless; scale freely behind nginx upstream |
