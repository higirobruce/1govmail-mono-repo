# ─── Stage 1: Install dependencies ───────────────────────────────────────────
FROM node:22-alpine AS deps

# Build tools needed for native modules (better-sqlite3 for desktop compat)
RUN apk add --no-cache python3 make g++
RUN corepack enable

WORKDIR /repo

# Copy ALL workspace manifests — pnpm needs the full workspace graph.
# .npmrc sets shamefully-hoist=true so all binaries land in node_modules/.bin/
COPY .npmrc package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/

# Full install (no --filter) so the virtual store is complete.
# apps/desktop is excluded by .dockerignore so better-sqlite3 is never installed.
# A complete store is required for pnpm deploy --legacy to work offline (no registry calls).
RUN pnpm install --frozen-lockfile

# ─── Stage 2: Build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
RUN corepack enable
WORKDIR /repo

COPY --from=deps /repo/node_modules ./node_modules
COPY apps/api ./apps/api
# pnpm-workspace.yaml references apps/* — pnpm deploy needs all package.json manifests
# to resolve the workspace graph, even if the app itself isn't used here.
COPY apps/web/package.json ./apps/web/
COPY .npmrc package.json pnpm-workspace.yaml pnpm-lock.yaml ./

# Run prisma generate from apps/api so it auto-discovers prisma.config.ts
# and uses the correct schema + adapter for client generation.
RUN cd apps/api && ../../node_modules/.bin/prisma generate

# Compile TypeScript — run from apps/api so nest finds tsconfig.json
RUN cd apps/api && ../../node_modules/.bin/nest build

# Produce a self-contained production bundle (no devDependencies)
RUN pnpm deploy --filter api --prod --legacy /deploy

# Copy prisma schema, config, and migrations into the deploy root so that
# `prisma generate` (below) and `prisma migrate deploy` (in the migrate service)
# can find them at runtime.
RUN cp -r /repo/apps/api/prisma /deploy/prisma
RUN cp /repo/apps/api/prisma.config.ts /deploy/prisma.config.ts

# Re-run prisma generate inside the deployed node_modules.
# pnpm deploy creates a fresh copy of @prisma/client WITHOUT the generated code;
# running generate here writes the .prisma/client/* files into the correct
# pnpm virtual-store path inside /deploy/node_modules.
RUN cd /deploy && node_modules/.bin/prisma generate

# ─── Stage 3: Production image ────────────────────────────────────────────────
FROM node:22-alpine AS production
WORKDIR /app

ENV NODE_ENV=production

# /deploy contains: node_modules (with generated Prisma client), package.json,
# prisma/ (schema + migrations), prisma.config.ts
COPY --from=builder /deploy ./

# NestJS compiled output
COPY --from=builder /repo/apps/api/dist ./dist

EXPOSE 3001 1234

CMD ["node", "dist/src/main"]
