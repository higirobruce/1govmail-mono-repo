'use client';

import { useEffect } from 'react';

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;
    if (process.env.NODE_ENV !== 'production') return;

    const handler = () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // Registration failures are non-fatal — the app still works online.
      });
    };

    if (document.readyState === 'complete') {
      handler();
    } else {
      window.addEventListener('load', handler, { once: true });
      return () => window.removeEventListener('load', handler);
    }
  }, []);

  return null;
}
