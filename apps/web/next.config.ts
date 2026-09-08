import type { NextConfig } from "next";
import path from "path";

// API origin used by the CSP connect-src directive. The frontend calls the
// API directly from the browser, so we must whitelist its origin.
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api';
const API_ORIGIN = (() => {
  try {
    return new URL(API_URL).origin;
  } catch {
    return 'http://localhost:3001';
  }
})();

// Hocuspocus realtime collab server (ws:// or wss://).
const COLLAB_WS = process.env.NEXT_PUBLIC_COLLAB_WS_URL ?? 'ws://localhost:1234';
const COLLAB_ORIGIN = (() => {
  try {
    const u = new URL(COLLAB_WS);
    return u.origin.replace(/^ws/, 'http');
  } catch {
    return 'http://localhost:1234';
  }
})();

// Optional remote AI endpoint. Local AI servers (Ollama/LM Studio/llama.cpp)
// are allowed via the localhost-loopback patterns in connect-src below; ops
// can additionally whitelist a single trusted remote AI origin per deploy.
const AI_REMOTE = process.env.NEXT_PUBLIC_AI_URL ?? '';
const AI_REMOTE_ORIGIN = (() => {
  try {
    return AI_REMOTE ? new URL(AI_REMOTE).origin : '';
  } catch {
    return '';
  }
})();

// Plain-HTTP deployments (test VMs with no TLS terminator in front) must not
// force https: `upgrade-insecure-requests` rewrites every asset/API request
// to https and breaks the whole page, and HSTS poisons the host for future
// visits. Set HTTP_DEPLOY=1 at build time for such environments; TLS deploys
// (the default) keep both protections.
const HTTP_DEPLOY = process.env.HTTP_DEPLOY === '1';

// Script-src is kept permissive for dev (unsafe-inline for Next's hydration
// runtime). In production we still allow unsafe-inline because Next injects
// inline bootstrap scripts; tighten this once nonces are wired through.
const csp = [
  `default-src 'self'`,
  `script-src 'self' 'unsafe-inline' 'unsafe-eval'`,
  `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
  `img-src 'self' data: blob: https:`,
  `font-src 'self' data: https://fonts.gstatic.com`,
  `connect-src 'self' ${API_ORIGIN} ${COLLAB_ORIGIN.replace(/^http/, 'ws')} ${COLLAB_ORIGIN} http://localhost:* http://127.0.0.1:* http://[::1]:*${AI_REMOTE_ORIGIN ? ` ${AI_REMOTE_ORIGIN}` : ''}`,
  `frame-src 'self' blob:`,
  `frame-ancestors 'none'`,
  `base-uri 'self'`,
  `form-action 'self'`,
  `object-src 'none'`,
  `worker-src 'self' blob:`,
  ...(HTTP_DEPLOY ? [] : [`upgrade-insecure-requests`]),
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  ...(HTTP_DEPLOY
    ? []
    : [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' }]),
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
];

const nextConfig: NextConfig = {
  /**
   * `standalone` bundles the app into a self-contained Node.js server at
   * `.next/standalone/server.js`. The Electron desktop build uses this to
   * ship the web app without requiring a separate server process.
   *
   * In `next dev` (and regular browser usage) this setting has no effect.
   */
  output: 'standalone',

  transpilePackages: ['@email-client/shared'],

  turbopack: {
    root: path.resolve(__dirname, '../..'),
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
