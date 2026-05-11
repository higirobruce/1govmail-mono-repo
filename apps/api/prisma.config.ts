// Prisma 7 configuration file.
// Used by the Prisma CLI (prisma generate, prisma migrate, etc.).
// Runtime connections are established by passing an adapter to PrismaClient
// directly (see src/prisma/prisma.service.ts).
import { defineConfig } from "prisma/config";

// Load .env for local development. dotenv is a devDependency and is absent
// from the production bundle — DATABASE_URL is injected via docker-compose env.
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("dotenv/config");
} catch {
  // production: dotenv absent — DATABASE_URL already set in env
}

// In Prisma 7, `datasource.url` here is used by the CLI (prisma migrate, generate).
// The runtime application uses @prisma/adapter-pg passed to PrismaClient directly
// (see src/prisma/prisma.service.ts and src/collab/collab.server.ts).
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
