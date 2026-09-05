# ─── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
RUN corepack enable
WORKDIR /repo

# Copy ALL workspace manifests — pnpm needs the full workspace graph to
# correctly resolve and link packages (e.g. @tiptap/core) across apps.
COPY .npmrc package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json ./apps/web/
COPY apps/api/package.json ./apps/api/

# --filter "web..." installs only web's dependency tree — avoids triggering
# native module builds (better-sqlite3) from the api workspace package.
RUN pnpm install --filter "web..." --frozen-lockfile

COPY apps/web ./apps/web

# NEXT_PUBLIC_* vars are baked into the JS bundle at build time.
# Pass them as build args: docker build --build-arg NEXT_PUBLIC_API_URL=...
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_COLLAB_WS_URL
ARG NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_COLLAB_WS_URL=$NEXT_PUBLIC_COLLAB_WS_URL
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL

RUN pnpm --filter web build

# ─── Stage 2: Production image ────────────────────────────────────────────────
FROM node:22-alpine AS production
WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# Chromium is required by the /export/docs/pdf route (puppeteer-core → headless
# Chrome). Alpine's package brings in the right fonts/libs for basic PDF render.
# PUPPETEER_SKIP_DOWNLOAD prevents any future puppeteer install from pulling a
# second copy; PUPPETEER_EXECUTABLE_PATH is picked up by findChromeBinary().
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Next.js standalone server (mirrors the electron-builder resource layout)
COPY --from=builder --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /repo/apps/web/.next/static     ./apps/web/.next/static/
COPY --from=builder --chown=node:node /repo/apps/web/public           ./apps/web/public/

# Run as the unprivileged `node` user (built into the base image) so Chromium's
# sandbox is active — puppeteer no longer passes --no-sandbox, and Chrome
# refuses to sandbox when running as root.
RUN chown node:node /app
USER node

# The /export and /upload routes are gated by apps/web/middleware.ts, which
# verifies the API's JWTs — provide JWT_SECRET (same value as the api service)
# at runtime, or the middleware falls back to validating tokens against
# NEXT_PUBLIC_API_URL.

EXPOSE 3000

# server.js is emitted at the standalone root by Next.js
# In a pnpm monorepo the standalone output nests server.js under the workspace path:
# .next/standalone/apps/web/server.js — not at the standalone root.
CMD ["node", "apps/web/server.js"]
