# ─── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
RUN corepack enable
WORKDIR /repo

# Copy workspace manifests only — maximises layer cache
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json ./apps/web/

RUN pnpm install --filter web --frozen-lockfile

COPY apps/web ./apps/web

# NEXT_PUBLIC_* vars are baked into the JS bundle at build time.
# Pass them as build args: docker build --build-arg NEXT_PUBLIC_API_URL=...
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_COLLAB_WS_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_COLLAB_WS_URL=$NEXT_PUBLIC_COLLAB_WS_URL

RUN pnpm --filter web build

# ─── Stage 2: Production image ────────────────────────────────────────────────
FROM node:22-alpine AS production
WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# Next.js standalone server (mirrors the electron-builder resource layout)
COPY --from=builder /repo/apps/web/.next/standalone ./
COPY --from=builder /repo/apps/web/.next/static     ./apps/web/.next/static/
COPY --from=builder /repo/apps/web/public           ./apps/web/public/

EXPOSE 3000

# server.js is emitted at the standalone root by Next.js
CMD ["node", "server.js"]
