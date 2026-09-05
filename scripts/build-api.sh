#!/usr/bin/env bash
# Build the API for the offline test VMs (Ubuntu 20.04 / OpenSSL 1.1).
# Builds inside node:22-bullseye (linux/amd64) so Prisma/OpenSSL artifacts match the VMs.
# Clones the local repo at HEAD — uncommitted changes never ship.
# Output: $OUT/api-<rev>.tar.gz (pnpm-deployed, prod-only bundle: extract over /opt/govmail/api).
# Deploy: scp tarball to VM /tmp, extract to /tmp/api.new, stop govmail-api,
#         swap directories, chown risa1, start govmail-api. No `prisma migrate`
#         needed unless the schema changed. Bundle is identical for both VMs
#         (no baked URLs — config comes from the VM's own env/.env file).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${OUT:-$REPO/.build-out}"
mkdir -p "$OUT"

docker run --rm --platform linux/amd64 \
  -v "$REPO":/srcrepo:ro \
  -v govmail-pnpm-store:/pnpm-store \
  -v "$OUT":/out \
  node:22-bullseye bash -euo pipefail -c '
    git config --global --add safe.directory /srcrepo
    git clone --depth 1 file:///srcrepo /build
    cd /build
    REV=$(git rev-parse --short HEAD)
    echo "== building api at $REV =="
    corepack enable pnpm
    pnpm config set store-dir /pnpm-store
    pnpm install --frozen-lockfile --filter api...
    cd apps/api
    pnpm exec prisma generate --schema prisma/schema.prisma
    pnpm build
    cd /build
    pnpm --filter api deploy --prod --legacy /bundle
    # `pnpm deploy` copies only files pnpm knows about; dist/ is gitignored
    # so it never makes it into the deploy bundle on its own. Copy it in
    # explicitly. Entry point is dist/src/main.js (nest-cli sourceRoot=src).
    cp -r /build/apps/api/dist /bundle/dist
    # `prisma generate` above ran against the WORKSPACE root and wrote the
    # generated client into /build/node_modules/.prisma/client — that is a
    # generated artifact, not a store package, so `pnpm deploy` has no way
    # to carry it into the bundles isolated node_modules. Without this, the
    # bundle boots with @prisma/client present but no generated client and
    # crash-loops on `Cannot find module ".prisma/client/default"`.
    # Regenerate again, this time inside the bundle, against its own copy
    # of prisma/ and its own node_modules, so the client lands where the
    # bundled runtime will actually look for it.
    [ -f /bundle/prisma/schema.prisma ] || cp -r /build/apps/api/prisma /bundle/prisma
    cd /bundle
    ./node_modules/.bin/prisma generate --schema=prisma/schema.prisma
    tar -czf /out/api-$REV.tar.gz .
    echo "== done: /out/api-$REV.tar.gz =="
  '
