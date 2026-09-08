/**
 * Clients for the phase 3b one-shot generations: POST /ai/dossier and
 * POST /ai/meeting-prep (same SSE protocol as /ai/ask — leading
 * `event: sources`, then deltas) plus their cached GET companions.
 */
import { authedFetch } from '../authed-fetch';
import { AIHttpError } from './client';
import type { AskSource } from './ask';
import { readSse } from './sse';

export interface CachedGeneration {
  content: string;
  sources: AskSource[];
  generatedAt: string; // ISO
  stale: boolean;
}

export type GenerationDegraded = Record<string, boolean>;

interface StreamOpts {
  onSources: (sources: AskSource[], degraded: GenerationDegraded) => void;
  onChunk: (delta: string) => void;
  signal?: AbortSignal;
}

async function streamGeneration(path: string, body: object, opts: StreamOpts): Promise<string> {
  const res = await authedFetch(path, { method: 'POST', body: JSON.stringify(body), signal: opts.signal });
  if (!res.ok || !res.body) {
    let message = `AI request failed (${res.status})`;
    try {
      const json = await res.json();
      message = `AI request failed (${res.status}): ${json?.message ?? res.statusText}`;
    } catch { /* stream body — keep default */ }
    throw new AIHttpError(message, res.status);
  }
  return readSse(res, {
    onSources: (sources, degraded) => opts.onSources(sources ?? [], degraded ?? {}),
    onChunk: opts.onChunk,
  });
}

export function streamDossier(email: string, opts: StreamOpts): Promise<string> {
  return streamGeneration('/ai/dossier', { email: email.trim().toLowerCase() }, opts);
}

export function streamMeetingPrep(eventId: string, opts: StreamOpts): Promise<string> {
  return streamGeneration('/ai/meeting-prep', { eventId }, opts);
}

async function getCached(path: string): Promise<CachedGeneration | null> {
  const res = await authedFetch(path);
  if (!res.ok) return null; // cache miss is never fatal — the panel just shows the generate button
  const json = await res.json().catch(() => null);
  return json?.cached ?? null;
}

export function getCachedDossier(email: string): Promise<CachedGeneration | null> {
  return getCached(`/ai/dossier?email=${encodeURIComponent(email.trim().toLowerCase())}`);
}

export function getCachedMeetingPrep(eventId: string): Promise<CachedGeneration | null> {
  return getCached(`/ai/meeting-prep?eventId=${encodeURIComponent(eventId)}`);
}
