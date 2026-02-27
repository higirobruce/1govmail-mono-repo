// Prisma 7 configuration file.
// Used by the Prisma CLI (prisma generate, prisma migrate, etc.).
// Runtime connections are established by passing an adapter to PrismaClient
// directly (see src/prisma/prisma.service.ts).
import { defineConfig } from "prisma/config";

// Load .env for local development.  dotenv is a devDependency and is absent
// from the production bundle — in that context DATABASE_URL is injected
// directly into the process environment by the Electron main process, so a
// missing dotenv package must not crash startup.
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("dotenv/config");
} catch {
  // production: dotenv absent — DATABASE_URL already set in env
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // The Prisma CLI uses this URL for migration operations.
    // It accepts the SQLite "file:" scheme directly.
    url: process.env["DATABASE_URL"] ?? "file:./dev.db",
  },
});
