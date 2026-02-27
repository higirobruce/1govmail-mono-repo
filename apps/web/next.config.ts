import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  /**
   * `standalone` bundles the app into a self-contained Node.js server at
   * `.next/standalone/server.js`. The Electron desktop build uses this to
   * ship the web app without requiring a separate server process.
   *
   * In `next dev` (and regular browser usage) this setting has no effect.
   */
  output: 'standalone',

  /**
   * Explicitly point Turbopack at the monorepo root so it doesn't get
   * confused by the workspace layout when running `next build` from
   * apps/web (or via `pnpm --filter web build` from the root).
   * Without this, Next.js 16 emits a warning about multiple lockfiles
   * and may resolve the wrong workspace root.
   */
  turbopack: {
    root: path.resolve(__dirname, '../..'),
  },
};

export default nextConfig;
