#!/usr/bin/env node
/**
 * prepare-api.mjs
 *
 * Builds the NestJS API and stages a self-contained deployment bundle at
 * apps/desktop/api-bundle/ so that electron-builder can copy it into the
 * packaged app as extraResources.
 *
 * Steps
 * ─────
 * 1. Compile TypeScript  →  apps/api/dist/
 * 2. Generate Prisma client with all binaryTargets
 * 3. Use `pnpm deploy` to create api-bundle/ with real (non-symlinked) node_modules
 * 4. Copy compiled dist/ and prisma/ into api-bundle/
 * 4b. Copy generated .prisma/client/ from root pnpm store into api-bundle/ pnpm store
 *     (`pnpm deploy` copies @prisma/client but NOT the generated client output)
 * 5. Rebuild better-sqlite3 native module for the Electron runtime using
 *    @electron/rebuild, so the packaged app can load it without issues.
 */

import { execSync, execFileSync } from 'child_process';
import {
  cpSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);

const rootDir    = join(__dirname, '../../..');
const apiDir     = join(rootDir, 'apps/api');
const desktopDir = join(rootDir, 'apps/desktop');
const bundleDir  = join(desktopDir, 'api-bundle');

// ─── Helper ────────────────────────────────────────────────────────────────────
function run(cmd, opts = {}) {
  console.log(`\n▶ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: rootDir, ...opts });
}

// ─── 1. Build TypeScript ───────────────────────────────────────────────────────
console.log('\n═══ Step 1/6 — Building NestJS API ═══');
run('pnpm --filter api build');

// ─── 2. Generate Prisma client (all binary targets) ───────────────────────────
console.log('\n═══ Step 2/6 — Generating Prisma client ═══');
run('pnpm --filter api exec prisma generate');

// ─── 3. pnpm deploy → self-contained node_modules ─────────────────────────────
console.log('\n═══ Step 3/6 — Deploying API dependencies ═══');
rmSync(bundleDir, { recursive: true, force: true });
mkdirSync(bundleDir, { recursive: true });
// pnpm deploy copies production dependencies into bundleDir/node_modules
// with real file copies (no symlinks), which electron-builder can package.
// --legacy is required for pnpm v10+, which changed the default deploy
// behaviour to require inject-workspace-packages=true.  The legacy mode
// preserves the pre-v10 behaviour of copying deps without injection.
run(`pnpm --filter api deploy --prod --legacy ${bundleDir}`);

// ─── 4. Copy dist/ and prisma/ ────────────────────────────────────────────────
console.log('\n═══ Step 4/6 — Copying dist/ and prisma/ ═══');
cpSync(join(apiDir, 'dist'),   join(bundleDir, 'dist'),   { recursive: true });
cpSync(join(apiDir, 'prisma'), join(bundleDir, 'prisma'), { recursive: true });

// ─── 4b. Copy generated Prisma client (.prisma/client/) ──────────────────────
//
// `pnpm deploy --prod` copies the @prisma/client package files but does NOT
// copy the generated client output (.prisma/client/) that lives alongside it
// in the pnpm content-addressed store.  Without this the bundled NestJS process
// crashes on startup with:
//   Error: Cannot find module '.prisma/client/default'
//
// Both root and bundle share the same pnpm package key so we just find the
// matching @prisma+client@* directory inside the bundle's .pnpm/ store and
// copy the .prisma/ folder from the equivalent root-store location.
console.log('\n═══ Step 4b/6 — Copying generated Prisma client (.prisma/) ═══');
{
  const rootPnpmDir   = join(rootDir,   'node_modules/.pnpm');
  const bundlePnpmDir = join(bundleDir, 'node_modules/.pnpm');

  const prismaClientKey = readdirSync(bundlePnpmDir)
    .find(d => d.startsWith('@prisma+client@'));

  if (!prismaClientKey) {
    console.error('  ERROR: @prisma+client not found in bundle .pnpm store.');
    console.error('  Make sure `pnpm deploy` completed successfully (step 3).');
    process.exit(1);
  }

  const srcDotPrisma    = join(rootPnpmDir,   prismaClientKey, 'node_modules/.prisma');
  const targetDotPrisma = join(bundlePnpmDir, prismaClientKey, 'node_modules/.prisma');

  if (!existsSync(srcDotPrisma)) {
    console.error(`  ERROR: .prisma/ not found at ${srcDotPrisma}`);
    console.error('  Make sure `prisma generate` ran successfully (step 2).');
    process.exit(1);
  }

  cpSync(srcDotPrisma, targetDotPrisma, { recursive: true });
  console.log(`  Copied .prisma/ → ${targetDotPrisma}`);
}

// ─── 5. Rebuild / download better-sqlite3 for Electron ───────────────────────
//
// There can be MULTIPLE better-sqlite3 versions in the pnpm virtual store:
//   • one direct dep (e.g. better-sqlite3@11.x)   ← hoisted to node_modules/
//   • one via @prisma/adapter-better-sqlite3 (e.g. better-sqlite3@12.x)
//                                                   ← only in .pnpm store
//
// Cross-platform strategy
// ───────────────────────
// When TARGET_PLATFORM differs from the host OS (e.g. building a Linux AppImage
// or Windows installer from macOS), node-gyp would compile a host-platform
// binary (Mach-O on macOS) that the target OS cannot load (ELF on Linux, PE on
// Windows).  Instead we use `prebuild-install` — already bundled as a dep of
// better-sqlite3 — to download the correct pre-built binary from GitHub Releases.
//
// Native builds (TARGET_PLATFORM === host OS) keep the existing node-gyp path.
// Set TARGET_PLATFORM and TARGET_ARCH env vars to cross-compile, e.g.:
//   TARGET_PLATFORM=linux TARGET_ARCH=x64 pnpm build:desktop:linux
console.log('\n═══ Step 5/6 — Preparing better-sqlite3 for Electron ═══');

// Resolve the Electron version bundled with the desktop workspace.
const electronPkgPath = join(desktopDir, 'node_modules/electron/package.json');
if (!existsSync(electronPkgPath)) {
  console.error('electron package not found in apps/desktop/node_modules — run pnpm install first');
  process.exit(1);
}
const electronVersion = JSON.parse(readFileSync(electronPkgPath, 'utf-8')).version;

// TARGET_PLATFORM / TARGET_ARCH let callers specify the build target explicitly.
// Defaults to the current host so native builds require no extra env vars.
const targetPlatform = process.env.TARGET_PLATFORM || process.platform; // linux | win32 | darwin
const targetArch     = process.env.TARGET_ARCH     || process.arch;     // x64 | arm64
const isCross        = targetPlatform !== process.platform || targetArch !== process.arch;

console.log(
  `  Electron: ${electronVersion}` +
  `  target: ${targetPlatform}-${targetArch}` +
  (isCross ? `  host: ${process.platform}-${process.arch}  [cross-compile → prebuild-install]` : '  [native → node-gyp]'),
);

const bundlePnpmDir = join(bundleDir, 'node_modules/.pnpm');
const sqlite3Keys = readdirSync(bundlePnpmDir).filter(d => d.startsWith('better-sqlite3@'));
if (sqlite3Keys.length === 0) {
  console.error('  ERROR: no better-sqlite3 found in bundle .pnpm store.');
  console.error('  Make sure `pnpm deploy` completed successfully (step 3).');
  process.exit(1);
}
console.log(`  Found ${sqlite3Keys.length} better-sqlite3 version(s): ${sqlite3Keys.join(', ')}`);

for (const key of sqlite3Keys) {
  const pkgDir = join(bundlePnpmDir, key, 'node_modules', 'better-sqlite3');

  if (isCross) {
    // ── Cross-platform: download pre-built binary from GitHub Releases ──────
    // prebuild-install is a direct dependency of better-sqlite3 and is stored
    // alongside it in the pnpm virtual store at node_modules/.bin/prebuild-install.
    const prebuildBin = join(pkgDir, 'node_modules', '.bin', 'prebuild-install');
    if (!existsSync(prebuildBin)) {
      console.error(`  ERROR: prebuild-install not found at ${prebuildBin}`);
      process.exit(1);
    }
    console.log(`\n  Downloading pre-built ${key} for ${targetPlatform}-${targetArch} (Electron ${electronVersion}) …`);
    execFileSync(
      prebuildBin,
      [
        `--runtime=electron`,
        `--target=${electronVersion}`,
        `--arch=${targetArch}`,
        `--platform=${targetPlatform}`,
        `--tag-prefix=v`,
        `--force-download`,
      ],
      { stdio: 'inherit', cwd: pkgDir },
    );
    console.log(`  ✓ ${key} pre-built binary downloaded`);
  } else {
    // ── Native: compile with node-gyp targeting the Electron runtime ────────
    // The Electron headers are downloaded once to ~/.electron-gyp and cached.
    console.log(`\n  Rebuilding ${key} with node-gyp for Electron ${electronVersion} …`);
    execSync(
      `npx --yes node-gyp rebuild` +
      ` --target=${electronVersion}` +
      ` --arch=${targetArch}` +
      ` --dist-url=https://electronjs.org/headers` +
      ` --directory="${pkgDir}"`,
      {
        stdio: 'inherit',
        cwd:   pkgDir,
        env:   { ...process.env, HOME: join(process.env.HOME ?? '~', '.electron-gyp') },
      },
    );
    console.log(`  ✓ ${key} rebuilt`);
  }
}

console.log('\n✓ API bundle ready at:', bundleDir);

