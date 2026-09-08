/**
 * Bare fetch wrapper that adds the JWT Authorization header from the same
 * Zustand-persisted auth store the rest of the app uses, and returns the raw
 * Response so callers that need streaming bodies (SSE) aren't forced through
 * the JSON-only `api.request` path.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api';

/**
 * Also used by callers that hit the web app's own Route Handlers (/export/*,
 * /upload/*), which are gated by middleware.ts and so need the bearer token
 * without authedFetch's API_BASE prefix.
 */
export function getAuthToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem('auth');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: { token?: string | null } };
    return parsed?.state?.token ?? null;
  } catch {
    return null;
  }
}

/** Authorization header alone, for FormData posts that must not set Content-Type. */
export function bearerHeaders(): Record<string, string> {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getAuthToken();
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
}
