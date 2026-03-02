# 1Gov Mail — Deployment Architecture

> **Audience:** DevOps engineers, maintainers, and anyone responsible for building, releasing, or hosting 1Gov Mail.
> **Last updated:** March 2026
> **Version:** 1.4.x

---

## Table of Contents

1. [Deployment Landscape Overview](#1-deployment-landscape-overview)
2. [Build Pipeline — Desktop (Electron)](#2-build-pipeline--desktop-electron)
3. [Build Pipeline — Web (Next.js)](#3-build-pipeline--web-nextjs)
4. [CI/CD — GitHub Actions](#4-cicd--github-actions)
5. [Release Process](#5-release-process)
6. [Runtime Architecture — Desktop](#6-runtime-architecture--desktop)
7. [Runtime Architecture — Web (Production)](#7-runtime-architecture--web-production)
8. [Data & File Locations](#8-data--file-locations)
9. [Environment Variables Reference](#9-environment-variables-reference)
10. [Cross-Platform Native Module Strategy](#10-cross-platform-native-module-strategy)
11. [Security Model](#11-security-model)
12. [Recommended Web Hosting Setup](#12-recommended-web-hosting-setup)
13. [Runbooks](#13-runbooks)

---

## 1. Deployment Landscape Overview

The product ships as two independent delivery targets:

| Target | Distribution | Built by | Status |
|--------|-------------|---------|--------|
| **Desktop** | GitHub Releases (DMG / EXE / AppImage) | GitHub Actions (CI/CD) | Production |
| **Web** | Self-hosted / any Node.js host | Manual | Ready to deploy |

There is no SaaS hosting, no Docker setup, and no cloud-managed database — SQLite runs locally inside the Electron app on the user's machine, and on the server for a web deployment.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    1Gov Mail — Delivery Targets                         │
│                                                                         │
│   Developer pushes tag (v1.x.x)                                         │
│          │                                                              │
│          ▼                                                              │
│   GitHub Actions (build-desktop.yml)                                    │
│   ┌──────────────┬──────────────┬───────────────┐                       │
│   │ macos-latest │ubuntu-latest │windows-latest │                       │
│   │   ↓ DMG      │  ↓ AppImage  │  ↓ NSIS EXE   │                       │
│   └──────┬───────┴──────┬───────┴───────┬────────┘                       │
│          └──────────────┴───────────────┘                               │
│                         ▼                                               │
│              GitHub Releases page                                       │
│              (user downloads & installs)                                │
│                                                                         │
│   Web deployment (separate — manual):                                   │
│   Server ─ Node.js ─ Next.js standalone + NestJS API + SQLite           │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Build Pipeline — Desktop (Electron)

The desktop build is the most complex part of the system. It bundles three separate processes (Electron main, Next.js web server, NestJS API server) plus native addons into a single distributable.

### 2.1 High-Level Build Flow

```
pnpm build:desktop:mac   (or :win / :linux)
  │
  ├─ 1. apps/web — Next.js standalone build
  │      next build  (output: 'standalone')
  │      → .next/standalone/apps/web/server.js
  │      → .next/static/
  │
  ├─ 2. apps/desktop — prebuild hooks
  │      ├─ scripts/generate-icons.mjs
  │      │    SVG → .icns (macOS) / .ico (Windows) / .png (Linux)
  │      └─ scripts/prepare-api.mjs
  │           ├─ Build NestJS API  (pnpm --filter api build)
  │           ├─ Generate Prisma client  (prisma generate)
  │           ├─ Deploy prod deps  (pnpm deploy --prod)
  │           ├─ Copy dist/ + prisma/
  │           ├─ Embed .prisma/client/ from pnpm store
  │           └─ Compile better-sqlite3 for Electron runtime
  │                ├─ Same platform → node-gyp rebuild
  │                └─ Cross-platform → prebuild-install (prebuilt binaries)
  │
  ├─ 3. apps/desktop — TypeScript compile
  │      tsc  → dist/main.js  dist/preload.js
  │
  └─ 4. electron-builder package
         Gathers all resources:
           dist/main.js + dist/preload.js         (Electron main process)
           ../web/.next/standalone → app/          (Next.js server)
           ../web/.next/static    → app/apps/web/.next/static
           ../web/public          → app/apps/web/public
           api-bundle/            → api/           (NestJS API + deps)
         Produces:
           release/1Gov Mail.dmg       (macOS)
           release/1Gov Mail Setup.exe (Windows)
           release/1Gov Mail.AppImage  (Linux)
```

### 2.2 prepare-api.mjs in Detail

This script is the heart of the desktop build. It creates a fully self-contained NestJS installation at `apps/desktop/api-bundle/`.

```
scripts/prepare-api.mjs
  │
  Step 1 — Build NestJS
  │   pnpm --filter api build
  │   Output: apps/api/dist/src/main.js
  │
  Step 2 — Generate Prisma client for all targets
  │   pnpm --filter api exec prisma generate
  │   binaryTargets: native, darwin, darwin-arm64,
  │                  windows, debian-openssl-3.0.x, linux-musl
  │
  Step 3 — Deploy production dependencies (no devDeps, real files not symlinks)
  │   pnpm --filter api deploy --prod --legacy
  │   → apps/desktop/api-bundle/node_modules/
  │   NOTE: pnpm deploy flattens symlinks for cross-machine portability
  │
  Step 4 — Copy build artefacts into bundle
  │   apps/api/dist/     → api-bundle/dist/
  │   apps/api/prisma/   → api-bundle/prisma/
  │   (migrations folder travels with the app for the custom migration runner)
  │
  Step 5 — Embed Prisma client from pnpm store
  │   Locate .prisma/client/ inside pnpm content-addressable store
  │   Copy to api-bundle/node_modules/.prisma/client/
  │   (pnpm store uses symlinks; electron-builder cannot follow them into ~/.pnpm-store)
  │
  Step 6 — Prepare better-sqlite3 native addon
      ├─ Same platform (e.g., building macOS app on macOS):
      │    node-gyp rebuild --electron --target=<electron version>
      │    Produces: node_modules/better-sqlite3/build/Release/better_sqlite3.node
      │
      └─ Cross-platform (e.g., building Linux AppImage on macOS):
           TARGET_PLATFORM=linux TARGET_ARCH=x64
           prebuild-install --runtime=electron --target=<version> --platform=linux --arch=x64
           Downloads prebuilt .node from GitHub Releases of better-sqlite3
           (No build toolchain needed on the host machine)
```

### 2.3 electron-builder.yml Resource Layout

After `electron-builder` runs, the packaged app contains:

```
1Gov Mail.app/Contents/
├── MacOS/
│   └── 1Gov Mail                (Electron binary)
├── Resources/
│   ├── app/                     (Electron main + preload)
│   │   ├── dist/
│   │   │   ├── main.js
│   │   │   └── preload.js
│   │   └── package.json
│   ├── app/apps/web/            (Next.js standalone server)
│   │   ├── server.js            (entry point)
│   │   ├── .next/
│   │   │   └── static/          (client JS/CSS bundles)
│   │   └── public/              (static assets)
│   └── api/                     (NestJS API)
│       ├── dist/src/main.js     (entry point)
│       ├── prisma/
│       │   ├── schema.prisma
│       │   └── migrations/      (SQL migration files)
│       └── node_modules/        (production deps, including better-sqlite3.node)
└── Info.plist
```

### 2.4 Platform Build Commands

```bash
# macOS (universal binary: Intel + Apple Silicon)
pnpm build:desktop:mac

# Windows x64 (run on macOS or Windows — cross-compile via prebuild-install)
pnpm build:desktop:win

# Linux x64 AppImage (run on macOS or Linux)
pnpm build:desktop:linux

# All platforms (sequential)
pnpm build:desktop
```

> **Native build on the target OS always produces the most reliable binary.**
> Cross-compilation (e.g., building Windows EXE on macOS) works for the installer packaging
> but relies on prebuilt `better-sqlite3` binaries from GitHub Releases.

---

## 3. Build Pipeline — Web (Next.js)

The web app uses Next.js `output: 'standalone'` — a self-contained Node.js server that can run anywhere without a separate `node_modules` install.

```
pnpm --filter web build
  │
  │  NEXT_PUBLIC_API_URL must be set before build
  │  (baked into client-side JS bundles at build time)
  │
  └─ next build
       → apps/web/.next/standalone/   (standalone server)
            apps/web/server.js        (entry point)
            node_modules/             (only prod deps, deduplicated)
       → apps/web/.next/static/       (client bundles — served separately)
       → apps/web/public/             (static files — served separately)
```

### Running the standalone server

```bash
# Must copy static assets alongside the standalone build first:
cp -r apps/web/.next/static  apps/web/.next/standalone/apps/web/.next/static
cp -r apps/web/public        apps/web/.next/standalone/apps/web/public

# Start:
PORT=3000 HOSTNAME=0.0.0.0 \
  NEXT_PUBLIC_API_URL=https://api.yourdomain.com/api \
  node apps/web/.next/standalone/apps/web/server.js
```

### API build

```bash
pnpm --filter api build
# → apps/api/dist/src/main.js

pnpm --filter api start:prod
# node dist/src/main
```

---

## 4. CI/CD — GitHub Actions

**File:** `.github/workflows/build-desktop.yml`

### Triggers

```yaml
on:
  push:
    tags:
      - 'v*'          # e.g. v1.4.1, v2.0.0
  workflow_dispatch:  # Manual trigger from GitHub UI
```

### Job Matrix

Each platform builds on its **native runner** — this is required because `better-sqlite3` compiles against the Electron runtime using `node-gyp`, which needs the host OS's build tools.

```
Tag push (v*)
     │
     ├──────────────────────────────────────────────────────┐
     │                        │                            │
     ▼                        ▼                            ▼
macos-latest            ubuntu-latest              windows-latest
  │                        │                            │
  │ apt deps: N/A          │ apt deps:                  │ No extra deps
  │                        │  build-essential           │
  │                        │  python3                   │
  │                        │  libc6-dev                 │
  │                        │  libssl-dev                │
  │                        │  rpm fakeroot              │
  │                        │                            │
  ├─ pnpm install           ├─ pnpm install              ├─ pnpm install
  ├─ pnpm build:desktop:mac ├─ pnpm build:desktop:linux  ├─ pnpm build:desktop:win
  │                         │                            │
  ▼                         ▼                            ▼
1Gov Mail-1.x.x.dmg   1Gov Mail-1.x.x.AppImage   1Gov Mail Setup 1.x.x.exe
  │                         │                            │
  └─────────────────────────┴────────────────────────────┘
                            │
                  upload-artifact (90-day retention)
                  (not yet published to GitHub Release automatically —
                   artifacts are downloaded manually or via release workflow)
```

### Code Signing (currently disabled)

The workflow has signing configuration commented out:

```yaml
# These secrets need to be set in GitHub repo settings to enable signing:
# APPLE_ID              — Apple Developer account email
# APPLE_APP_SPECIFIC_PASSWORD — App-specific password for notarization
# CSC_LINK              — Base64-encoded .p12 certificate (Apple signing)
# CSC_KEY_PASSWORD      — Password for the .p12 certificate
# WINDOWS_CERTIFICATE   — Base64-encoded .pfx certificate (Windows signing)
# WINDOWS_CERTIFICATE_PASSWORD
```

**Without signing:**
- macOS: Users see "unidentified developer" warning; must right-click → Open
- Windows: SmartScreen warning on first run

**To enable macOS signing + notarization:**
1. Enroll in Apple Developer Program ($99/year)
2. Export .p12 from Keychain, base64-encode it
3. Add secrets to GitHub repository settings
4. Uncomment signing env vars in workflow YAML

### Adding the web app to CI

The web app currently has no CI deployment. To add it, append a job:

```yaml
deploy-web:
  runs-on: ubuntu-latest
  needs: []
  steps:
    - uses: actions/checkout@v4
    - uses: pnpm/action-setup@v3
      with: { version: '10' }
    - uses: actions/setup-node@v4
      with: { node-version: '20', cache: 'pnpm' }
    - run: pnpm install
    - run: pnpm --filter web build
      env:
        NEXT_PUBLIC_API_URL: ${{ secrets.PROD_API_URL }}
    # Then rsync / scp / fly deploy / etc.
```

---

## 5. Release Process

### Step-by-step

```
Developer (local machine)
  │
  ├─ 1. Write code, commit with conventional commit messages
  │       feat(mail): add scheduled send
  │       fix(tasks): due reminder not sending
  │       chore: update dependencies
  │
  ├─ 2. Run release
  │       pnpm release          # interactive, prompts for semver bump
  │       pnpm release:dry      # dry run — preview changes without pushing
  │
  │    release-it does:
  │      a. Bumps version in package.json (patch / minor / major)
  │      b. Generates / updates CHANGELOG.md (Angular conventional preset)
  │      c. Commits: "chore(release): v1.4.1"
  │      d. Creates annotated git tag: v1.4.1
  │      e. Pushes commit + tag to GitHub
  │      f. Creates GitHub Release with CHANGELOG notes
  │      g. Runs after:release hook ↓
  │
  ├─ 3. After-release hook (scripts/update-website-version.mjs)
  │       Opens ~/Documents/development/1govmail-web/website
  │       Updates lib/releases.ts:
  │         CURRENT_VERSION = "1.4.1"
  │         RELEASE_DATE = "March 2026"
  │       git commit + git push (website repo)
  │
  └─ 4. Tag push triggers GitHub Actions (build-desktop.yml)
          3 parallel native builds (macOS / Linux / Windows)
          Artifacts uploaded → GitHub Actions run page
          (manual download or wire into GitHub Release assets)
```

### Versioning scheme

Follows **Semantic Versioning (SemVer)** driven by conventional commits:

| Commit prefix | Version bump |
|---------------|-------------|
| `fix:` | Patch (1.4.0 → 1.4.1) |
| `feat:` | Minor (1.4.0 → 1.5.0) |
| `feat!:` or `BREAKING CHANGE:` | Major (1.4.0 → 2.0.0) |
| `chore:`, `docs:`, `refactor:` | No bump (unless manually chosen) |

---

## 6. Runtime Architecture — Desktop

When a user launches the installed desktop app, the Electron main process orchestrates three Node.js runtimes on loopback interfaces.

### Startup sequence

```
User double-clicks app
  │
  ▼
Electron Main Process (dist/main.js)
  │
  ├─ requestSingleInstanceLock()
  │    Already running? → focus existing window, exit new instance
  │
  ├─ Read / generate JWT secret
  │    ~/.../1Gov Mail/userData/.jwt-secret
  │    (48-byte random hex, mode 0o600, persists across restarts)
  │
  ├─ Run Prisma migrations (custom SQLite runner)
  │    Open userData/mail.db via better-sqlite3 (synchronous)
  │    CREATE TABLE IF NOT EXISTS _prisma_migrations
  │    Read Resources/api/prisma/migrations/ (alphabetical)
  │    For each unapplied migration:
  │      BEGIN TRANSACTION
  │      Execute migration.sql
  │      INSERT INTO _prisma_migrations (applied_at = now)
  │      COMMIT
  │
  ├─ startApiServer()   ← spawn NestJS
  │    spawn('node', ['api/dist/src/main.js'])
  │    env:
  │      PORT=3457
  │      DATABASE_URL=file:userData/mail.db
  │      JWT_SECRET=<persistent secret>
  │      FRONTEND_URL=http://127.0.0.1:3456
  │      NODE_ENV=production
  │    Poll GET http://127.0.0.1:3457/api (max 40 attempts × 500ms = 20s)
  │    Resolves when HTTP response received (any status)
  │
  ├─ startNextServer()  ← spawn Next.js
  │    spawn('node', ['app/apps/web/server.js'])
  │    env:
  │      PORT=3456
  │      HOSTNAME=127.0.0.1
  │      NEXT_PUBLIC_API_URL=http://127.0.0.1:3457/api
  │      NODE_ENV=production
  │      NEXT_TELEMETRY_DISABLED=1
  │    Watch stdout for "Ready in Xms"
  │    Hard timeout: 30 seconds
  │
  └─ Create BrowserWindow
       Load http://127.0.0.1:3456
       contextIsolation=true, nodeIntegration=false
       Preload: dist/preload.js (IPC bridge)
```

### Runtime process topology

```
OS (macOS / Windows / Linux)
  │
  └─ Electron Main Process  (PID A)
       ├─ Manages window lifecycle, tray, IPC
       ├─ Holds JWT secret in memory
       │
       ├─ Child Process: NestJS API  (PID B)
       │    Binds:  127.0.0.1:3457   (HTTP REST)
       │            127.0.0.1:1234   (Hocuspocus WebSocket)
       │    DB:     userData/mail.db  (SQLite / better-sqlite3)
       │    Talks:  Zimbra server (external HTTPS)
       │
       ├─ Child Process: Next.js Server  (PID C)
       │    Binds:  127.0.0.1:3456   (HTTP)
       │    Talks:  127.0.0.1:3457   (fetch calls to API)
       │
       └─ Renderer Process  (PID D — Chromium)
            Loads:  http://127.0.0.1:3456
            Talks:  127.0.0.1:3457  (REST API — client-side fetch)
                    127.0.0.1:1234  (Hocuspocus WS — docs collab)
```

> **Security note:** All ports bind to `127.0.0.1` (loopback only). No service is exposed on `0.0.0.0`. Other processes on the machine can reach these ports, but they cannot be accessed over the network.

### Desktop network map

```
                     ┌─────────────────────┐
                     │   Zimbra Server      │
                     │   (external HTTPS)   │
                     └──────────┬──────────┘
                                │ SOAP / REST
                                ▼
  ┌─────────────────────────────────────────────────────────┐
  │  User Machine                                           │
  │                                                         │
  │  ┌─────────────────────────────┐                        │
  │  │  Electron Renderer          │                        │
  │  │  (Chromium — BrowserWindow) │                        │
  │  │                             │◀── page load ──────┐  │
  │  │  fetch → :3457 (REST)       │                    │  │
  │  │  ws    → :1234 (Collab)     │                    │  │
  │  └──────────────┬──────────────┘                    │  │
  │                 │                                   │  │
  │          ┌──────▼──────────────────────────┐        │  │
  │          │   127.0.0.1:3457  NestJS API    │        │  │
  │          │   127.0.0.1:1234  Hocuspocus WS │        │  │
  │          │   userData/mail.db  (SQLite)    │        │  │
  │          └─────────────────────────────────┘        │  │
  │                                                     │  │
  │          ┌──────────────────────────────────────────┘  │
  │          │   127.0.0.1:3456  Next.js Server           │
  │          │   (serves HTML/JS/CSS to Renderer)         │
  │          └──────────────────────────────────────────── │
  └─────────────────────────────────────────────────────────┘
```

### IPC channels (Renderer ↔ Main)

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `notify` | Renderer → Main | Fire OS native notification |
| `badge-count` | Renderer → Main | Update macOS Dock unread badge |

Implemented via `contextBridge` in `preload.ts` with `contextIsolation: true`.

### Tray & window behaviour

| Event | macOS | Windows/Linux |
|-------|-------|---------------|
| Window close (X button) | Hide to tray | Quit app |
| Tray left-click | Show/focus window | Show/focus window |
| Dock click (macOS) | Show/focus window | N/A |
| Second instance launched | Focus existing window | Focus existing window |
| Quit from tray menu | Terminate all child processes + quit | Same |

---

## 7. Runtime Architecture — Web (Production)

There is currently no production web deployment. The web app is `output: 'standalone'` — ready to deploy anywhere that can run Node.js.

### Recommended production topology

```
Internet
   │  HTTPS :443
   ▼
┌─────────────────────────────────────────────────────────────┐
│  Reverse Proxy  (Nginx / Caddy / Traefik)                   │
│                                                             │
│  /         → proxy_pass http://127.0.0.1:3000  (Next.js)   │
│  /api/     → proxy_pass http://127.0.0.1:3001  (NestJS)    │
│  /ws/      → proxy_pass ws://127.0.0.1:1234    (Collab WS) │
│                                                             │
│  TLS termination here (Let's Encrypt / org cert)            │
└──────────┬──────────────────────┬────────────────────────── ┘
           │                      │
    ┌──────▼──────┐     ┌─────────▼──────────────────────┐
    │  Next.js    │     │  NestJS API + Hocuspocus       │
    │  :3000      │     │  :3001 (HTTP) + :1234 (WS)     │
    │  server.js  │     │  dist/src/main.js              │
    └─────────────┘     └─────────────┬──────────────────┘
                                      │
                              ┌───────▼────────┐
                              │   SQLite DB    │
                              │   /data/db.db  │
                              └────────────────┘
                                      │
                              ┌───────▼────────┐
                              │ Zimbra Server  │
                              │ (external)     │
                              └────────────────┘
```

### Nginx config snippet

```nginx
server {
    listen 443 ssl http2;
    server_name mail.yourdomain.com;

    # TLS
    ssl_certificate     /etc/ssl/certs/mail.crt;
    ssl_certificate_key /etc/ssl/private/mail.key;

    # Next.js — static assets (direct serve, no proxy)
    location /_next/static/ {
        alias /opt/1govmail/web/.next/static/;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    location /public/ {
        alias /opt/1govmail/web/public/;
        expires 7d;
    }

    # Next.js — SSR
    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }

    # NestJS REST API
    location /api/ {
        proxy_pass         http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        client_max_body_size 55m;   # Match NestJS 50MB body limit
    }

    # Hocuspocus WebSocket (docs real-time collab)
    location /ws/ {
        proxy_pass         http://127.0.0.1:1234;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        proxy_read_timeout 3600s;   # Keep WS connections alive
        proxy_send_timeout 3600s;
    }
}

# Redirect HTTP → HTTPS
server {
    listen 80;
    server_name mail.yourdomain.com;
    return 301 https://$host$request_uri;
}
```

> **Note:** If the WebSocket collab server stays on port 1234 without a path prefix, update `NEXT_PUBLIC_COLLAB_WS_URL` to `wss://mail.yourdomain.com/ws/` and set the Hocuspocus server path accordingly, or expose port 1234 directly with its own subdomain.

### Process management (web server)

Use **PM2** or **systemd** to keep processes alive and restart on crash.

**PM2 ecosystem file** (`ecosystem.config.js`):

```js
module.exports = {
  apps: [
    {
      name: '1govmail-api',
      script: 'dist/src/main.js',
      cwd: '/opt/1govmail/api',
      instances: 1,            // SQLite = single process only
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        HOCUSPOCUS_PORT: 1234,
        DATABASE_URL: 'file:/data/mail.db',
        JWT_SECRET: '<long-random-secret>',
        FRONTEND_URL: 'https://mail.yourdomain.com',
      },
    },
    {
      name: '1govmail-web',
      script: 'apps/web/server.js',
      cwd: '/opt/1govmail/web',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        HOSTNAME: '127.0.0.1',
        NEXT_TELEMETRY_DISABLED: 1,
        NEXT_PUBLIC_API_URL: 'https://mail.yourdomain.com/api',
      },
    },
  ],
};
```

> **SQLite constraint:** NestJS must run as a **single process** (`instances: 1`, `exec_mode: 'fork'`). SQLite with better-sqlite3 (synchronous driver) does not support concurrent write access from multiple processes. If you need horizontal scale, migrate to PostgreSQL with the Prisma postgres adapter.

---

## 8. Data & File Locations

### Desktop (per-user, per-OS)

| OS | userData path | DB file | JWT secret |
|----|--------------|---------|------------|
| macOS | `~/Library/Application Support/1Gov Mail/` | `mail.db` | `.jwt-secret` |
| Windows | `%APPDATA%\1Gov Mail\` | `mail.db` | `.jwt-secret` |
| Linux | `~/.config/1Gov Mail/` | `mail.db` | `.jwt-secret` |

**Backup guidance:** Back up `mail.db` to preserve tasks, documents, templates, rules, contact groups, and notification history. Mail/contacts/calendar will resync from Zimbra automatically.

### Web server

| Path | Contents |
|------|----------|
| `/data/mail.db` (recommended) | SQLite database |
| `/opt/1govmail/api/` | NestJS build (`dist/`, `prisma/`, `node_modules/`) |
| `/opt/1govmail/web/` | Next.js standalone (`server.js`, `.next/`, `public/`) |

Mount `/data` on a persistent volume if running in a container or VM that may be reprovisioned.

---

## 9. Environment Variables Reference

### API (`apps/api/.env` or system env)

| Variable | Default | Production requirement |
|----------|---------|----------------------|
| `PORT` | `3001` | Set to `3001` (or adjust nginx upstream) |
| `DATABASE_URL` | `file:./dev.db` | **Required** — absolute path, e.g. `file:/data/mail.db` |
| `JWT_SECRET` | `change-this-in-prod` | **Required** — minimum 64 random chars |
| `JWT_EXPIRES_IN` | `7d` | Tune to security policy |
| `FRONTEND_URL` | `http://localhost:3000` | **Required** — must match web origin for CORS |
| `HOCUSPOCUS_PORT` | `1234` | Set if 1234 is already in use |

### Web (`apps/web/.env.local` or build-time env)

| Variable | Default | Production requirement |
|----------|---------|----------------------|
| `NEXT_PUBLIC_API_URL` | `http://localhost:3001/api` | **Required** — baked into client JS at build time |
| `NEXT_PUBLIC_COLLAB_WS_URL` | `ws://localhost:1234` | Set to `wss://` for production |
| `NEXT_PUBLIC_USE_MOCK` | `false` | Must be `false` in production |

### Desktop (set by Electron main process — not configurable by user)

| Variable | Value |
|----------|-------|
| `PORT` | `3457` (API) / `3456` (Web) |
| `DATABASE_URL` | `file:<userData>/mail.db` |
| `JWT_SECRET` | Read from `<userData>/.jwt-secret` |
| `FRONTEND_URL` | `http://127.0.0.1:3456` |
| `HOSTNAME` | `127.0.0.1` |
| `NODE_ENV` | `production` |
| `NEXT_TELEMETRY_DISABLED` | `1` |
| `NEXT_PUBLIC_API_URL` | `http://127.0.0.1:3457/api` |

---

## 10. Cross-Platform Native Module Strategy

`better-sqlite3` is a C++ native addon — it must be compiled against the exact Electron runtime version and target OS/architecture.

### Decision matrix

| Build scenario | Strategy | How |
|----------------|----------|-----|
| macOS app built on macOS | Native node-gyp compile | `node-gyp rebuild --target=<electronVersion> --runtime=electron --dist-url=...` |
| Linux AppImage built on macOS | prebuild-install download | `prebuild-install --runtime=electron --target=<version> --platform=linux --arch=x64` |
| Windows EXE built on macOS | prebuild-install download | `prebuild-install --runtime=electron --target=<version> --platform=win32 --arch=x64` |
| Windows EXE built on Windows | Native node-gyp compile | Same as macOS on macOS |
| Linux AppImage built on Linux | Native node-gyp compile | Same as macOS on macOS |

Prebuilt binaries for `better-sqlite3` are hosted on the `better-sqlite3` GitHub Releases page. If a version is missing, the build falls back to native compilation on the host.

**`npmRebuild: false`** is set in `electron-builder.yml` to prevent electron-builder from running its own `npm rebuild`, since `prepare-api.mjs` already handles this correctly.

### Prisma binary targets

```prisma
binaryTargets = [
  "native",
  "darwin",
  "darwin-arm64",
  "windows",
  "debian-openssl-3.0.x",
  "linux-musl"
]
```

All targets are generated by `prisma generate` during the desktop prebuild step. The app bundle contains all binaries; Prisma picks the correct one at runtime via the `PRISMA_QUERY_ENGINE_LIBRARY` env (or falls back to `native`).

> **However:** The desktop app uses `@prisma/adapter-better-sqlite3` which routes queries through the `better-sqlite3` JS driver, **bypassing the Prisma Rust query engine entirely**. The `binaryTargets` array is kept for compatibility but the Rust binaries are not used at runtime in the desktop build.

---

## 11. Security Model

### Desktop

| Concern | Mitigation |
|---------|-----------|
| Network exposure | All services bind `127.0.0.1` only — not accessible over LAN/WAN |
| JWT secret | Stored at `userData/.jwt-secret` with mode `0o600` — only the current OS user can read it |
| Renderer isolation | `contextIsolation: true`, `nodeIntegration: false` — renderer cannot access Node.js APIs directly |
| IPC attack surface | `preload.ts` exposes only two channels (`notify`, `badge-count`) via `contextBridge` |
| Second instance | `requestSingleInstanceLock()` prevents token replay via a second Electron instance |
| SQLite | Single-file DB in `userData/` — protected by OS file permissions for the logged-in user |

### Web

| Concern | Mitigation |
|---------|-----------|
| Authentication | JWT, configurable expiry, stored in Zustand/localStorage |
| CORS | `FRONTEND_URL` env var controls allowed origin — set to exact domain in prod |
| Body size | NestJS rejects requests >50MB |
| CSRF | Zimbra CSRF token stored and forwarded on mutating SOAP requests |
| Transport | All production traffic over HTTPS (TLS at reverse proxy) |
| Secrets | `JWT_SECRET` must be set via environment — never committed to source |
| SQLite | Single process only; file protected by OS filesystem permissions |

### What is NOT implemented (known gaps)

| Gap | Impact | Mitigation suggestion |
|-----|--------|-----------------------|
| No request rate limiting | API could be brute-forced | Add `@nestjs/throttler` |
| No auto-update | Users run outdated versions until they manually download | Add `electron-updater` |
| No macOS/Windows code signing | OS security warnings on install | Obtain developer certificates |
| No audit logging | No record of who accessed/sent email | Add request logging middleware |
| SQLite = no multi-instance scale | Single web server process only | Migrate to PostgreSQL for horizontal scale |
| Sessions not revoked on JWT expiry | Token technically still valid until `JWT_EXPIRES_IN` | Add token blocklist in Redis or check session table |

---

## 12. Recommended Web Hosting Setup

For teams deploying 1Gov Mail as a shared web service (not per-user desktop), the minimal production setup is:

```
Cloud VM / VPS (2 vCPU, 2 GB RAM recommended)
  │
  ├─ /etc/nginx/sites-enabled/1govmail   (reverse proxy + TLS termination)
  ├─ /opt/1govmail/
  │    ├─ api/     (NestJS build + deps + prisma migrations)
  │    └─ web/     (Next.js standalone)
  ├─ /data/mail.db                       (SQLite, on persistent volume)
  └─ PM2 (or systemd)                   (process supervisor)
```

### Deployment steps (first time)

```bash
# 1. On your dev machine: build
NEXT_PUBLIC_API_URL=https://mail.yourdomain.com/api \
  pnpm --filter web build

pnpm --filter api build
npx --filter api prisma generate

# 2. Sync to server
rsync -av apps/web/.next/standalone/   server:/opt/1govmail/web/
rsync -av apps/web/.next/static/       server:/opt/1govmail/web/apps/web/.next/static/
rsync -av apps/web/public/             server:/opt/1govmail/web/apps/web/public/
rsync -av apps/api/dist/               server:/opt/1govmail/api/dist/
rsync -av apps/api/prisma/             server:/opt/1govmail/api/prisma/
rsync -av apps/api/node_modules/       server:/opt/1govmail/api/node_modules/

# 3. On the server: run migrations
cd /opt/1govmail/api
DATABASE_URL=file:/data/mail.db npx prisma migrate deploy

# 4. Start with PM2
pm2 start /opt/1govmail/ecosystem.config.js
pm2 save
pm2 startup   # generate systemd unit for PM2 itself
```

### Deployment steps (update)

```bash
# On dev machine: build & sync (same as above)

# On server: restart processes (zero-downtime via PM2 reload)
pm2 reload 1govmail-api
pm2 reload 1govmail-web

# Run any new migrations
cd /opt/1govmail/api
DATABASE_URL=file:/data/mail.db npx prisma migrate deploy
```

---

## 13. Runbooks

### Runbook 1 — Cut a new desktop release

```bash
# Ensure you are on main and everything is committed
git status

# Dry run first — preview version bump and changelog
pnpm release:dry

# Release (interactive — select patch / minor / major)
pnpm release
# release-it will:
#   bump version, update CHANGELOG.md, tag, push, create GitHub Release

# GitHub Actions automatically starts building DMG / AppImage / EXE
# Monitor at: https://github.com/<org>/email-client/actions

# After CI succeeds, download artifacts from the Actions run page
# and upload them to the GitHub Release (or automate this in the workflow)
```

### Runbook 2 — Build desktop locally for testing

```bash
# macOS DMG (requires macOS machine)
pnpm build:desktop:mac

# Windows EXE (cross-compiled from macOS — needs prebuild-install)
pnpm build:desktop:win

# Linux AppImage (cross-compiled from macOS)
pnpm build:desktop:linux

# Output in:
ls apps/desktop/release/
```

### Runbook 3 — Apply a schema migration (web server)

```bash
# 1. Add model to apps/api/prisma/schema.prisma
# 2. Generate migration (dev only — creates SQL file)
cd apps/api && npx prisma migrate dev --name add_<feature>

# 3. Build and deploy code (see Runbook: Update)

# 4. On the server — apply migration (safe to run multiple times)
DATABASE_URL=file:/data/mail.db npx prisma migrate deploy

# 5. If Prisma client types are stale in NestJS watch mode:
rm -f dist/tsconfig.tsbuildinfo dist/tsconfig.build.tsbuildinfo
# Then rebuild / restart the API
```

### Runbook 4 — Recover from corrupt desktop database

The SQLite DB in `userData/mail.db` is a local cache. Deleting it forces a full resync from Zimbra.

```bash
# macOS
rm ~/Library/Application\ Support/1Gov\ Mail/mail.db

# Windows
del %APPDATA%\1Gov Mail\mail.db

# Linux
rm ~/.config/1Gov\ Mail/mail.db
```

> **Data lost on delete:** Tasks, documents (collaborative docs), templates, mail rules, contact groups, notifications, and snooze/scheduled entries are stored **only** in SQLite — they are NOT on Zimbra. Back these up before deleting. Mail metadata and bodies are safely re-fetched from Zimbra.

### Runbook 5 — Rotate the JWT secret (desktop)

Rotating the secret will invalidate all existing sessions (users must log in again):

```bash
# macOS
rm ~/Library/Application\ Support/1Gov\ Mail/.jwt-secret
# Relaunch app — new secret generated on startup
```

### Runbook 6 — Enable macOS code signing

1. Create an Apple Developer account (developer.apple.com)
2. In Xcode or Keychain Access, create a "Developer ID Application" certificate
3. Export as `.p12`, base64-encode:
   ```bash
   base64 -i certificate.p12 | pbcopy
   ```
4. Add secrets to GitHub repository (`Settings → Secrets → Actions`):
   - `CSC_LINK` — base64 `.p12` content
   - `CSC_KEY_PASSWORD` — `.p12` password
   - `APPLE_ID` — Apple account email
   - `APPLE_APP_SPECIFIC_PASSWORD` — app-specific password from appleid.apple.com
5. Uncomment signing env vars in `.github/workflows/build-desktop.yml`
6. Next release tag will produce a notarized, signed DMG

### Runbook 7 — Monitor web server health

```bash
# Check API is responding
curl -s http://127.0.0.1:3001/api | head -c 200

# Check Next.js is responding
curl -s http://127.0.0.1:3000 | head -c 200

# PM2 status
pm2 status
pm2 logs 1govmail-api --lines 50
pm2 logs 1govmail-web --lines 50

# SQLite DB size
ls -lh /data/mail.db

# Active sessions (SQLite)
sqlite3 /data/mail.db "SELECT COUNT(*) FROM sessions WHERE expires_at > datetime('now');"
```

---

*This document covers the deployment architecture as of v1.4.0. Update it when adding containerisation, auto-update support, or production web hosting.*
