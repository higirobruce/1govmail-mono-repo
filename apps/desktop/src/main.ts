import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  Notification,
  shell,
} from 'electron';
import * as path from 'path';
import * as http from 'http';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';

// ─── Constants ─────────────────────────────────────────────────────────────────
const isDev = !app.isPackaged;
const WEB_DEV_PORT  = 3000;
const WEB_PROD_PORT = 3456;
const API_PROD_PORT = 3457;   // Bundled NestJS API

const APP_URL = isDev
  ? `http://localhost:${WEB_DEV_PORT}`
  : `http://127.0.0.1:${WEB_PROD_PORT}`;

// ─── State ─────────────────────────────────────────────────────────────────────
let mainWindow:  BrowserWindow | null = null;
let tray:        Tray | null          = null;
let webProcess:  ChildProcess | null  = null;
let apiProcess:  ChildProcess | null  = null;
let isQuitting = false;

// ─── Persistent JWT secret ─────────────────────────────────────────────────────
/**
 * A random secret is generated on first launch and stored in userData so that
 * the same secret is reused across restarts (keeping existing sessions valid).
 * The file is readable only by the current OS user (mode 0o600 on creation).
 */
function getOrCreateJwtSecret(): string {
  const secretPath = path.join(app.getPath('userData'), '.jwt-secret');
  if (fs.existsSync(secretPath)) {
    return fs.readFileSync(secretPath, 'utf-8').trim();
  }
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(secretPath, secret, { mode: 0o600 });
  return secret;
}

// ─── Production: run Prisma migrations ────────────────────────────────────────
/**
 * Applies pending SQLite migrations directly via better-sqlite3, bypassing the
 * Prisma Rust migration-engine binary entirely.
 *
 * Why not `prisma migrate deploy`?  The Prisma CLI bundles a platform-specific
 * Rust migration-engine binary.  When the app is built on macOS, only the macOS
 * binary ends up in the bundle — so `prisma migrate deploy` exits with code 1 on
 * Linux (AppImage) and Windows.
 *
 * This implementation replicates what the migration engine does:
 *  1. Ensures the `_prisma_migrations` tracking table exists.
 *  2. Reads each migration directory from prisma/migrations/, sorted by name.
 *  3. Skips migrations already recorded as finished in the tracking table.
 *  4. Executes the migration SQL in a transaction and records it.
 *
 * It is fully compatible with Prisma's own tracking table so switching back to
 * the CLI (in dev) continues to work without re-applying migrations.
 */
function runApiMigrations(apiDir: string, dbPath: string): void {
  const migrationsDir = path.join(apiDir, 'prisma', 'migrations');

  if (!fs.existsSync(migrationsDir)) {
    console.warn('[migrations] Migrations directory not found — skipping');
    return;
  }

  // Load better-sqlite3 from the bundle (already rebuilt for Electron in prepare-api.mjs).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require(path.join(apiDir, 'node_modules', 'better-sqlite3')) as
    new (path: string) => {
      exec(sql: string): void;
      prepare(sql: string): { get(...args: unknown[]): unknown; run(...args: unknown[]): void };
      transaction<T>(fn: () => T): () => T;
      close(): void;
    };

  const db = new Database(dbPath);

  try {
    // Ensure the Prisma migrations tracking table exists.
    db.exec(`
      CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
        "id"                  TEXT NOT NULL PRIMARY KEY,
        "checksum"            TEXT NOT NULL,
        "finished_at"         DATETIME,
        "migration_name"      TEXT NOT NULL,
        "logs"                TEXT,
        "rolled_back_at"      DATETIME,
        "started_at"          DATETIME NOT NULL DEFAULT current_timestamp,
        "applied_steps_count" INTEGER  NOT NULL DEFAULT 0
      )
    `);

    const migrationDirs = fs
      .readdirSync(migrationsDir)
      .filter((d) => fs.statSync(path.join(migrationsDir, d)).isDirectory())
      .sort();                         // alphabetical = chronological for Prisma names

    for (const migrationName of migrationDirs) {
      const sqlFile = path.join(migrationsDir, migrationName, 'migration.sql');
      if (!fs.existsSync(sqlFile)) continue;

      // Skip if already applied.
      const applied = db
        .prepare('SELECT id FROM "_prisma_migrations" WHERE migration_name = ? AND finished_at IS NOT NULL')
        .get(migrationName);
      if (applied) continue;

      const sql      = fs.readFileSync(sqlFile, 'utf-8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      const id       = crypto.randomUUID();

      console.log(`[migrations] Applying: ${migrationName}`);

      const apply = db.transaction(() => {
        db.exec(sql);
        db.prepare(`
          INSERT OR REPLACE INTO "_prisma_migrations"
            (id, checksum, migration_name, finished_at, applied_steps_count)
          VALUES (?, ?, ?, datetime('now'), 1)
        `).run(id, checksum, migrationName);
      });
      apply();

      console.log(`[migrations] Applied:  ${migrationName}`);
    }

    console.log('[migrations] All migrations up to date.');
  } finally {
    db.close();
  }
}

// ─── Production: spawn the bundled NestJS API server ──────────────────────────
function startApiServer(apiDir: string, dbPath: string, jwtSecret: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // NestJS compiles to dist/src/main.js (baseUrl "./" in tsconfig, no rootDir,
    // so TypeScript preserves the src/ directory prefix in the output).
    const serverScript = path.join(apiDir, 'dist', 'src', 'main.js');

    if (!fs.existsSync(serverScript)) {
      reject(new Error(`Bundled API server not found at ${serverScript}`));
      return;
    }

    apiProcess = spawn(
      process.execPath,
      [serverScript],
      {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          NODE_ENV:     'production',
          PORT:         String(API_PROD_PORT),
          DATABASE_URL: `file:${dbPath}`,
          JWT_SECRET:   jwtSecret,
          // Allow requests from the bundled Next.js frontend
          FRONTEND_URL: `http://127.0.0.1:${WEB_PROD_PORT}`,
        },
        cwd:   apiDir,
        stdio: 'ignore',
      },
    );

    apiProcess.on('error', (err) => reject(err));

    // Poll until the API accepts connections (max ~20 s)
    const poll = (attempts = 40) => {
      http
        .get(`http://127.0.0.1:${API_PROD_PORT}/api`, (res) => {
          // Any HTTP response (even 404) means the server is up
          resolve();
          res.resume();
        })
        .on('error', () => {
          if (attempts > 0) setTimeout(() => poll(attempts - 1), 500);
          else reject(new Error('API server did not become ready in time'));
        });
    };

    setTimeout(() => poll(), 1500);
  });
}

// ─── Production: spawn the bundled Next.js standalone server ──────────────────
function startNextServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    // In a pnpm monorepo, Next.js standalone preserves the workspace path:
    //   .next/standalone/apps/web/server.js  (not .next/standalone/server.js)
    // electron-builder copies .next/standalone → Resources/app/, so server.js
    // lands at Resources/app/apps/web/server.js.
    const serverDir    = path.join(process.resourcesPath, 'app', 'apps', 'web');
    const serverScript = path.join(serverDir, 'server.js');

    if (!fs.existsSync(serverScript)) {
      reject(new Error(`Bundled Next.js server not found at ${serverScript}`));
      return;
    }

    webProcess = spawn(process.execPath, [serverScript], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE:    '1',
        PORT:                    String(WEB_PROD_PORT),
        HOSTNAME:                '127.0.0.1',
        NODE_ENV:                'production',
        NEXT_TELEMETRY_DISABLED: '1',
        // Point the frontend at the bundled API
        NEXT_PUBLIC_API_URL: `http://127.0.0.1:${API_PROD_PORT}`,
      },
      cwd:   serverDir,
      // Pipe stdout/stderr so we can detect readiness from the "Ready" log line
      // instead of relying on HTTP polling (which is fragile when the Electron
      // main process is busy during startup).
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    webProcess.on('error', (err) => reject(err));

    let resolved = false;

    // Next.js prints "✓ Ready in Xms" when it is fully listening.
    // Resolve as soon as we see that line.
    webProcess.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      console.log('[next-server]', text.trim());
      if (!resolved && text.includes('Ready')) {
        resolved = true;
        resolve();
      }
    });

    // Forward stderr to the Electron console so crashes are visible in logs.
    webProcess.stderr?.on('data', (chunk: Buffer) => {
      console.error('[next-server stderr]', chunk.toString().trim());
    });

    // If the process exits before printing "Ready" something went wrong.
    webProcess.once('exit', (code) => {
      if (!resolved) {
        reject(new Error(`Next.js server exited with code ${code} before becoming ready`));
      }
    });

    // Hard timeout — should never be hit given Next.js starts in <1 s.
    setTimeout(() => {
      if (!resolved) reject(new Error('Next.js server did not become ready in time'));
    }, 30_000);
  });
}

// ─── Main window ───────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    // macOS: hide the native title bar but keep the traffic-light buttons.
    // Windows/Linux: keep the native frame (no custom controls needed).
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    title: '1Gov Mail',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    // Don't flash a white window before the app paints
    show: false,
    backgroundColor: '#0a0a0a',
  });

  mainWindow.loadURL(APP_URL);

  // Show as soon as the first frame is painted
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    if (isDev) mainWindow?.webContents.openDevTools({ mode: 'detach' });
  });

  // Intercept window close → hide to tray instead of quitting
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
      // macOS: also hide the Dock icon so the app feels truly background
      if (process.platform === 'darwin') app.dock.hide();
    }
  });

  // Open external links in the default browser, not in Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ─── System tray ───────────────────────────────────────────────────────────────
function createTray() {
  // macOS wants a "template" image (white + transparent, named *Template*)
  // so the OS can auto-invert it for dark/light menu bar.
  const iconName =
    process.platform === 'darwin' ? 'tray-icon-template.png' : 'tray-icon.png';

  const iconPath = isDev
    ? path.join(__dirname, '..', 'resources', iconName)
    : path.join(process.resourcesPath, iconName);

  let icon: Electron.NativeImage;
  if (fs.existsSync(iconPath)) {
    icon = nativeImage.createFromPath(iconPath);
    // Mark as template so macOS auto-colours it for menu-bar contrast
    if (process.platform === 'darwin') icon.setTemplateImage(true);
  } else {
    // Fallback: empty image (invisible tray icon — replace with real assets)
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip('1Gov Mail');

  const buildMenu = () =>
    Menu.buildFromTemplate([
      {
        label: 'Show 1Gov Mail',
        click: showWindow,
      },
      { type: 'separator' },
      {
        label: 'Quit',
        accelerator: process.platform === 'darwin' ? 'Cmd+Q' : undefined,
        click: () => quitApp(),
      },
    ]);

  tray.setContextMenu(buildMenu());

  // Left-click the tray icon → show/focus the window
  tray.on('click', showWindow);
}

// ─── IPC handlers ──────────────────────────────────────────────────────────────
function setupIPC() {
  // Renderer → fire a native OS notification
  ipcMain.on('notify', (_event, { title, body }: { title: string; body: string }) => {
    if (Notification.isSupported()) {
      const n = new Notification({ title, body, silent: false });
      // Clicking the notification brings the app to the front
      n.on('click', showWindow);
      n.show();
    }
  });

  // Renderer → update the macOS Dock badge with unread count
  ipcMain.on('badge-count', (_event, count: number) => {
    if (process.platform === 'darwin') {
      app.dock.setBadge(count > 0 ? String(count) : '');
    }
  });
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
function showWindow() {
  if (mainWindow) {
    if (!mainWindow.isVisible()) {
      mainWindow.show();
      // Re-show Dock icon on macOS
      if (process.platform === 'darwin') app.dock.show();
    }
    mainWindow.focus();
  }
}

function quitApp() {
  isQuitting = true;
  apiProcess?.kill();
  webProcess?.kill();
  app.quit();
}

// ─── Single-instance lock ──────────────────────────────────────────────────────
// Prevents multiple Electron processes from running simultaneously.
// Without this, clicking the app icon during the long startup wait (or
// re-opening the app after the error dialog) spawns a new instance each time,
// leading to multiple windows / port conflicts.
if (!app.requestSingleInstanceLock()) {
  // A primary instance is already running — hand off and exit.
  app.quit();
} else {
  // A second launch attempt while we're running → focus the existing window.
  app.on('second-instance', () => {
    if (mainWindow) showWindow();
  });
}

// ─── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  if (!isDev) {
    const apiDir    = path.join(process.resourcesPath, 'api');
    const dbPath    = path.join(app.getPath('userData'), 'mail.db');
    const jwtSecret = getOrCreateJwtSecret();

    try {
      // 1. Apply any pending SQLite migrations (idempotent — safe every start)
      runApiMigrations(apiDir, dbPath);

      // 2. Start bundled NestJS API server
      console.log('[startup] Starting API server …');
      await startApiServer(apiDir, dbPath, jwtSecret);
      console.log('[startup] API server ready.');

      // 3. Start bundled Next.js web server
      console.log('[startup] Starting Next.js server …');
      await startNextServer();
      console.log('[startup] Next.js server ready.');
    } catch (err) {
      console.error('[startup] Failed to start bundled servers:', err);
      const { dialog } = await import('electron');
      dialog.showErrorBox(
        '1Gov Mail — Startup Error',
        `Could not start the application.\n\n${err}`,
      );
      app.quit();
      return;
    }
  }

  createWindow();
  createTray();
  setupIPC();

  // macOS: clicking the Dock icon re-shows the window
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });
});

// Keep the app running when all windows are closed (lives in the tray)
app.on('window-all-closed', () => {
  // On macOS the convention is to keep the app alive unless the user explicitly quits
  if (process.platform !== 'darwin') {
    if (isQuitting) app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  apiProcess?.kill();
  webProcess?.kill();
});
