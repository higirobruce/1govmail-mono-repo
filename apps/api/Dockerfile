# ─── Stage 1: Install dependencies ───────────────────────────────────────────
FROM node:22-alpine AS deps

# Build tools needed for native modules (better-sqlite3, bcrypt, etc.)
RUN apk add --no-cache python3 make g++
RUN corepack enable

WORKDIR /repo

# Copy workspace manifests only — maximises layer cache
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/

RUN pnpm install --frozen-lockfile

# ─── Stage 2: Build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
RUN corepack enable
WORKDIR /repo

COPY --from=deps /repo/node_modules ./node_modules
COPY apps/api ./apps/api
COPY package.json pnpm-workspace.yaml ./

# Generate Prisma client for linux targets
RUN pnpm --filter api exec prisma generate

# Compile TypeScript
RUN pnpm --filter api build

# Produce a self-contained production bundle (no devDependencies)
RUN pnpm deploy --filter api --prod /deploy

# Overwrite with the compiled Prisma client (pnpm deploy uses pre-generate snapshot)
RUN cp -r /repo/node_modules/.prisma /deploy/node_modules/.prisma

# ─── Stage 3: Production image ────────────────────────────────────────────────
FROM node:22-alpine AS production
WORKDIR /app

ENV NODE_ENV=production

# Self-contained app directory from pnpm deploy
COPY --from=builder /deploy ./

# NestJS compiled output
COPY --from=builder /repo/apps/api/dist ./dist

# Prisma migrations (needed by `prisma migrate deploy` at startup)
COPY --from=builder /repo/apps/api/prisma ./prisma

EXPOSE 3001 1234

CMD ["node", "dist/src/main"]
