// Cards are deterministic per (message, model) — temperature 0 — so a
// localStorage cache makes the second brief of the day map only new mail.
import type { BriefingCard } from './briefing';

const KEY = '1gov-brief-cards-v1';
export const CARD_CACHE_MAX = 500;

interface Entry { model: string; at: number; card: BriefingCard }

function load(): Record<string, Entry> {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

function save(map: Record<string, Entry>): void {
  try { localStorage.setItem(KEY, JSON.stringify(map)); } catch { /* quota — cache is best-effort */ }
}

export function getCachedCard(messageId: string, model: string): BriefingCard | null {
  const entry = load()[messageId];
  return entry && entry.model === model ? entry.card : null;
}

export function putCachedCard(messageId: string, model: string, card: BriefingCard): void {
  const map = load();
  map[messageId] = { model, at: Date.now(), card };
  const ids = Object.keys(map);
  if (ids.length > CARD_CACHE_MAX) {
    ids.sort((a, b) => map[a].at - map[b].at)
       .slice(0, ids.length - CARD_CACHE_MAX)
       .forEach((id) => delete map[id]);
  }
  save(map);
}
