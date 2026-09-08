#!/usr/bin/env bash
# Build the web app for the offline test VM 10.10.94.154 (Ubuntu 20.04 / OpenSSL 1.1).
# Builds inside node:22-bullseye (linux/amd64) so Prisma/OpenSSL artifacts match the VM.
# Clones the local repo at HEAD — uncommitted changes never ship.
# Output: $OUT/web-<rev>.tar.gz (standalone bundle: extract over /opt/govmail/web).
# Deploy: scp tarball to VM /tmp, extract to /tmp/web.new, stop govmail-web,
#         swap directories, chown risa1, start govmail-web.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${OUT:-$REPO/.build-out}"
mkdir -p "$OUT"

docker run --rm --platform linux/amd64 \
  -v "$REPO":/srcrepo:ro \
  -v govmail-pnpm-store:/pnpm-store \
  -v "$OUT":/out \
  -e HTTP_DEPLOY=1 \
  -e NEXT_PUBLIC_API_URL=http://10.10.94.154:3001/api \
  -e NEXT_PUBLIC_APP_URL=http://10.10.94.154:3000 \
  -e NEXT_PUBLIC_COLLAB_WS_URL=ws://10.10.94.154:1234 \
  node:22-bullseye bash -euo pipefail -c '
    git config --global --add safe.directory /srcrepo
    git clone --depth 1 file:///srcrepo /build
    cd /build
    REV=$(git rev-parse --short HEAD)
    echo "== building web at $REV =="
    corepack enable pnpm
    pnpm config set store-dir /pnpm-store
    pnpm install --frozen-lockfile --filter web...
    cd apps/web
    pnpm build
    cd .next/standalone
    mkdir -p apps/web/.next
    cp -r /build/apps/web/.next/static apps/web/.next/static
    [ -d /build/apps/web/public ] && cp -r /build/apps/web/public apps/web/public
    tar -czf /out/web-$REV.tar.gz .
    echo "== done: /out/web-$REV.tar.gz =="
  '
