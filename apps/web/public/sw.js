// Hand-rolled service worker for the 1Gov Mail app shell.
// Goal: when the user is offline and refreshes, the SW serves the cached
// HTML + Next.js JS chunks so the React app still boots. Once the app boots,
// the existing IndexedDB layer (lib/offline/*) handles data semantics.
//
// What this SW does NOT do: cache API responses. Those are owned by the
// IndexedDB cache. The SW intentionally treats /api/* requests as
// network-only so it never serves stale mail data.

const SW_VERSION = 'v1';
const STATIC_CACHE = `app-static-${SW_VERSION}`;
const PAGES_CACHE = `app-pages-${SW_VERSION}`;
const APP_SHELL_FALLBACK = '/mail';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(PAGES_CACHE)
      .then((cache) => cache.add(APP_SHELL_FALLBACK).catch(() => undefined)),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k !== STATIC_CACHE && k !== PAGES_CACHE)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Same-origin only — never intercept API or collab traffic.
  if (url.origin !== self.location.origin) return;

  // Never cache API routes — IndexedDB owns offline data semantics.
  if (url.pathname.startsWith('/api/')) return;

  // Navigation requests: NetworkFirst, fall back to cache, then to /mail shell.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          if (fresh && fresh.ok) {
            const cache = await caches.open(PAGES_CACHE);
            cache.put(req, fresh.clone());
          }
          return fresh;
        } catch {
          const cached = await caches.match(req);
          if (cached) return cached;
          const shell = await caches.match(APP_SHELL_FALLBACK);
          if (shell) return shell;
          return new Response(
            '<!doctype html><meta charset="utf-8"><title>Offline</title><body style="font-family:system-ui;padding:2rem;color:#444">You are offline and this page is not cached. Try again once you are connected.</body>',
            { status: 503, headers: { 'content-type': 'text/html' } },
          );
        }
      })(),
    );
    return;
  }

  // Next.js content-hashed static assets — immutable, so CacheFirst.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(cacheFirst(req, STATIC_CACHE));
    return;
  }

  // Fonts, images, manifest, icons — same strategy.
  if (
    /\.(?:woff2?|ttf|otf|eot|png|jpg|jpeg|svg|gif|webp|ico)$/i.test(url.pathname) ||
    url.pathname === '/manifest.webmanifest' ||
    url.pathname === '/icon' ||
    url.pathname === '/icon0' ||
    url.pathname === '/icon1'
  ) {
    event.respondWith(cacheFirst(req, STATIC_CACHE));
    return;
  }

  // Other GETs (e.g. /_next/data/*): NetworkFirst with cache fallback.
  event.respondWith(networkFirst(req, PAGES_CACHE));
});

async function cacheFirst(req, cacheName) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      const cache = await caches.open(cacheName);
      cache.put(req, fresh.clone());
    }
    return fresh;
  } catch (err) {
    return cached || Response.error();
  }
}

async function networkFirst(req, cacheName) {
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      const cache = await caches.open(cacheName);
      cache.put(req, fresh.clone());
    }
    return fresh;
  } catch {
    const cached = await caches.match(req);
    if (cached) return cached;
    return Response.error();
  }
}
