# 1Gov Mail — Centralized Deployment Guide (200+ Users)

> This guide covers deploying 1Gov Mail as a **centralized web backend** with the desktop app operating as a thin client connecting to it. It extends the existing `DEPLOYMENT.md` which documents the self-contained desktop build pipeline.

---

## Architecture Overview

The key shift is moving from the current **self-contained desktop model** (each desktop bundles its own NestJS + SQLite) to a **thin-client desktop model** where the desktop app connects to a shared central API.

```
                         ┌─────────────────────────────────────┐
                         │           Central Backend             │
  ┌──────────┐           │  ┌──────────┐    ┌───────────────┐  │
  │ Browser  │──HTTPS───▶│  │ Next.js  │    │  NestJS API   │  │
  └──────────┘           │  │  (web)   │    │  :3001/api    │  │
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
```

---

## 1. Critical Migration: SQLite → PostgreSQL

**This is the most important prerequisite.** SQLite cannot handle 200+ concurrent users with collaborative features — file locking, no connection pooling, no horizontal scaling.

### Steps

**a. Update Prisma schema** (`apps/api/prisma/schema.prisma`):
```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

**b. Replace the adapter** in `apps/api/src/main.ts` — remove the `better-sqlite3` adapter, use Prisma's default PostgreSQL connector.

**c. Update dependencies:**
```bash
cd apps/api
pnpm remove better-sqlite3
pnpm add pg
```

**d. Run migrations against PostgreSQL:**
```bash
DATABASE_URL="postgresql://..." npx prisma migrate deploy
```

**e. Remove `binaryTargets`** for SQLite from schema — PostgreSQL does not need them.

---

## 2. Infrastructure Requirements (200+ Users)

### Minimum Production Stack

| Component | Spec | Rationale |
|---|---|---|
| API Server | 4 vCPU, 8 GB RAM | NestJS + Hocuspocus WS handling concurrent connections |
| Web Server | 2 vCPU, 4 GB RAM | Next.js standalone; can share the API server initially |
| PostgreSQL | 4 vCPU, 16 GB RAM, SSD | Primary DB with WAL + connection pooling |
| Redis | 1 vCPU, 2 GB RAM | Session store, Bull queues, Hocuspocus pub/sub |
| Reverse Proxy | Nginx or Caddy | TLS termination, WS upgrade, static files |
| Object Storage | S3 or MinIO | Email attachments (currently stored on disk) |

> For 200 concurrent users, a single server (8 vCPU, 16 GB RAM) works as a starting point, with services split via Docker Compose or a small Kubernetes cluster.

---

## 3. Recommended: Docker Compose (Self-Hosted)

```yaml
# docker-compose.yml
services:
  postgres:
    image: postgres:17-alpine
    volumes:
      - pgdata:/var/lib/postgresql/data
    environment:
      POSTGRES_DB: govmail
      POSTGRES_USER: govmail
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U govmail"]
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    volumes:
      - redisdata:/data
    restart: unless-stopped

  api:
    build: ./apps/api
    ports:
      - "3001:3001"
      - "1234:1234"   # Hocuspocus WebSocket
    environment:
      DATABASE_URL: postgresql://govmail:${POSTGRES_PASSWORD}@postgres:5432/govmail
      REDIS_URL: redis://redis:6379
      JWT_SECRET: ${JWT_SECRET}
      FRONTEND_URL: https://mail.yourdomain.gov
      PORT: 3001
      HOCUSPOCUS_PORT: 1234
      NODE_ENV: production
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_started
    restart: unless-stopped

  web:
    build: ./apps/web
    ports:
      - "3000:3000"
    environment:
      NEXT_PUBLIC_API_URL: https://mail.yourdomain.gov/api
      NEXT_PUBLIC_COLLAB_WS_URL: wss://mail.yourdomain.gov/collab
    restart: unless-stopped

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf
      - ./certs:/etc/nginx/certs
    depends_on: [api, web]
    restart: unless-stopped

volumes:
  pgdata:
  redisdata:
```

---

## 4. Nginx Configuration

Critical for routing REST, WebSocket (collaboration), and the Next.js frontend through a single domain.

```nginx
upstream api       { server api:3001; }
upstream web       { server web:3000; }
upstream collab_ws { server api:1234; }

server {
  listen 80;
  server_name mail.yourdomain.gov;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl;
  server_name mail.yourdomain.gov;

  ssl_certificate     /etc/nginx/certs/fullchain.pem;
  ssl_certificate_key /etc/nginx/certs/privkey.pem;
  ssl_protocols       TLSv1.2 TLSv1.3;

  client_max_body_size 100M;  # for email attachments

  # Next.js web app
  location / {
    proxy_pass http://web;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  # NestJS REST API
  location /api/ {
    proxy_pass http://api;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  # Hocuspocus WebSocket (Docs/Tasks collaboration)
  location /collab {
    proxy_pass http://collab_ws;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 86400s;   # keep WS connections alive
    proxy_send_timeout 86400s;
  }
}
```

> **Key**: The `/collab` location maps to Hocuspocus on port 1234 with WebSocket upgrade headers. Both the desktop app and browser client connect to `wss://mail.yourdomain.gov/collab`.

---

## 5. Collaboration (Hocuspocus) at Scale

Hocuspocus with PostgreSQL needs a **Redis adapter** for pub/sub when running multiple API instances — without it, users connected to different instances won't sync.

```typescript
// apps/api/src/collab/collab.server.ts
import { Redis } from '@hocuspocus/extension-redis'

Server.configure({
  extensions: [
    new Redis({ host: process.env.REDIS_HOST, port: 6379 }),
    new Database({ ... }),  // existing PostgreSQL persistence
  ],
})
```

Install the extension:
```bash
cd apps/api
pnpm add @hocuspocus/extension-redis
```

---

## 6. Redis: Session Store & Queues

Add Redis for:

- **Hocuspocus pub/sub** — required for multi-instance collab
- **JWT blocklist** — invalidate tokens on logout across all devices
- **Bull queues** — notifications, email sending jobs
- **Rate limiting** — `@nestjs/throttler` with Redis store

```bash
cd apps/api
pnpm add @nestjs/cache-manager cache-manager @tirke/node-cache-manager-ioredis ioredis
```

---

## 7. Environment Variables Reference

### API (`apps/api/.env.production`)

```env
DATABASE_URL=postgresql://govmail:PASSWORD@postgres:5432/govmail
JWT_SECRET=<256-bit random — generate with: openssl rand -hex 32>
JWT_EXPIRES_IN=8h
FRONTEND_URL=https://mail.yourdomain.gov
PORT=3001
HOCUSPOCUS_PORT=1234
REDIS_URL=redis://redis:6379
NODE_ENV=production
```

### Web (`apps/web/.env.production`)

```env
NEXT_PUBLIC_API_URL=https://mail.yourdomain.gov/api
NEXT_PUBLIC_COLLAB_WS_URL=wss://mail.yourdomain.gov/collab
```

---

## 8. Desktop App: Thin Client Mode

The desktop app currently bundles its own backend. For the federated model it becomes a **thin client** that points to the central server.

### Required Changes

**a. Make the server URL configurable** — in the Electron main process, read the server URL from user settings or a bundled config file instead of hardcoding `http://127.0.0.1:3457`.

**b. Remove embedded API bundling** — skip `prepare-api.mjs` in the thin-client build variant. No `api-bundle/` resource is needed.

**c. Update `electron-builder.yml`** — remove the `api-bundle/` resource entry for the connected build target.

**d. Production env for thin client:**
```env
NEXT_PUBLIC_API_URL=https://mail.yourdomain.gov/api
NEXT_PUBLIC_COLLAB_WS_URL=wss://mail.yourdomain.gov/collab
```

### Two Build Variants (Recommended)

| Variant | Description |
|---|---|
| `1govmail-standalone` | Embedded NestJS + SQLite. Fully offline, single-user. Existing build pipeline unchanged. |
| `1govmail-connected` | Thin client. No embedded API. Points to central server. For org deployments. |

---

## 9. Deployment Checklist (Ordered)

```
Phase 1 — Foundation
  [ ] Provision server(s) + domain + TLS cert (Let's Encrypt / internal CA)
  [ ] Install Docker + Docker Compose (or Kubernetes)
  [ ] Set up PostgreSQL — create database and user
  [ ] Set up Redis

Phase 2 — Backend
  [ ] Update Prisma schema: sqlite → postgresql
  [ ] Add @hocuspocus/extension-redis to collab server
  [ ] Set all production env vars (especially JWT_SECRET)
  [ ] Run: npx prisma migrate deploy
  [ ] Deploy API container — verify GET /api/health

Phase 3 — Frontend
  [ ] Build Next.js with production NEXT_PUBLIC_* vars baked in
  [ ] Deploy web container
  [ ] Configure Nginx with WS upgrade for /collab
  [ ] Verify wss:// collaboration works end-to-end

Phase 4 — Desktop thin client
  [ ] Add server URL setting to Electron preferences UI
  [ ] Build connected variant without embedded API
  [ ] Distribute to users with server URL pre-configured or user-settable

Phase 5 — Hardening
  [ ] Automated PostgreSQL backups (pg_dump, daily minimum)
  [ ] Log aggregation (Loki + Grafana, or similar)
  [ ] Uptime monitoring (Uptime Kuma — self-hosted, simple)
  [ ] Rate limiting on /api/auth/* endpoints
  [ ] Document JWT_SECRET rotation procedure
  [ ] Review CORS: FRONTEND_URL must match production domain exactly
```

---

## 10. Scaling Beyond 200 Users

| Bottleneck | Solution |
|---|---|
| API CPU | Run 2+ API containers behind Nginx upstream; Redis adapter required for Hocuspocus |
| PostgreSQL connections | Add PgBouncer connection pooler in front of Postgres |
| WebSocket connections | Each Hocuspocus instance handles ~500–1000 WS connections; scale horizontally with Redis adapter |
| File attachments | Move to S3/MinIO; add `ATTACHMENT_STORAGE` env var and a storage service in NestJS |
| Next.js | Stateless; scale freely behind any load balancer |

---

## Summary of Key Actions

1. **Migrate SQLite → PostgreSQL** — non-negotiable for 200+ concurrent users
2. **Add Redis** — Hocuspocus pub/sub, session store, rate limiting
3. **Configure Nginx** with WebSocket upgrade for `/collab`
4. **Add `@hocuspocus/extension-redis`** to the collab server for multi-instance sync
5. **Rebuild desktop as thin client** — remove embedded API, point to central server URL
6. **Secure secrets** — strong `JWT_SECRET` (256-bit), TLS everywhere, env vars never committed to git