/**
 * Render a value that may be a native Date (Prisma DateTime in-process) as an
 * ISO string. `String(date)` must never be used — it emits toString()'s
 * locale-formatted "Mon Sep 01 2026 … GMT+0000 (…)" into refs and prompts.
 */
export function toIsoDate(raw: unknown): string {
  return raw instanceof Date ? raw.toISOString() : String(raw ?? '');
}
