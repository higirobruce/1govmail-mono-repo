'use client';

import { useSyncExternalStore } from 'react';

// True while the app is in dark mode. Reads the `.dark` class that
// ThemeProvider maintains on <html> (the single source of truth — it already
// resolves the light/dark/system setting), and re-renders subscribers when the
// class flips, so theme-derived values rebuilt in render (e.g. the email
// iframe srcDoc) stay in sync with a live theme switch.

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

const getSnapshot = () => document.documentElement.classList.contains('dark');
const getServerSnapshot = () => false;

export function useIsDark(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
