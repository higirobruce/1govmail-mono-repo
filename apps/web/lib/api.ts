import {
  MOCK_FOLDERS,
  MOCK_MESSAGES,
  MOCK_MESSAGE_DETAIL,
} from './mock-data';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api';
const USE_MOCK = process.env.NEXT_PUBLIC_USE_MOCK === 'true';

/**
 * Read the JWT from the Zustand persist store (localStorage key 'auth').
 * This is the single source of truth — avoids a separate 'access_token' key
 * that can fall out of sync with the Zustand state (e.g. after switching
 * between mock and real mode, or after a previous 401 cleared the old key).
 */
function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem('auth');
    if (raw) {
      const parsed = JSON.parse(raw) as { state?: { token?: string | null } };
      return parsed?.state?.token ?? null;
    }
  } catch {
    // corrupted storage — fall through to null
  }
  return null;
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });

  if (!res.ok) {
    // Only hard-redirect to /login when a token WAS sent and the server
    // still rejected it (genuine expiry / revocation). If we sent no token
    // the 401 is expected (unauthenticated call) and we just throw.
    if (res.status === 401 && token && typeof window !== 'undefined') {
      // Clear the persisted auth state so the store starts fresh on /login
      localStorage.removeItem('auth');
      localStorage.removeItem('access_token'); // legacy key, safe to clear
      window.location.replace('/login');
      throw new Error('Session expired — please log in again');
    }
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.message ?? 'Request failed');
  }

  return res.json() as Promise<T>;
}

function delay<T>(data: T, ms = 120): Promise<T> {
  return new Promise((r) => setTimeout(() => r(data), ms));
}

export const api = {
  contacts: {
    /**
     * Autocomplete email addresses / names from Zimbra contacts + GAL.
     * Returns up to ~20 matches for the given prefix query.
     */
    autocomplete: (q: string): Promise<Array<{ email: string; display: string }>> => {
      if (USE_MOCK) return delay<Array<{ email: string; display: string }>>([]);
      return request<Array<{ email: string; display: string }>>(
        `/contacts/autocomplete?q=${encodeURIComponent(q)}`,
      );
    },
    /** Fetch all contacts; sync=true forces a fresh pull from Zimbra. */
    getAll: (q?: string, sync = false) => {
      if (USE_MOCK) return delay<any[]>([]);
      const qs = new URLSearchParams();
      if (q) qs.set('q', q);
      if (sync) qs.set('sync', 'true');
      const str = qs.toString();
      return request<any[]>(`/contacts${str ? `?${str}` : ''}`);
    },
    create: (data: any) => {
      if (USE_MOCK) return delay({ id: `c-${Date.now()}`, ...data });
      return request<any>('/contacts', { method: 'POST', body: JSON.stringify(data) });
    },
    update: (id: string, data: any) => {
      if (USE_MOCK) return delay({ id, ...data });
      return request<any>(`/contacts/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
    },
    delete: (id: string) => {
      if (USE_MOCK) return delay({ success: true });
      return request<{ success: boolean }>(`/contacts/${id}`, { method: 'DELETE' });
    },
  },

  calendar: {
    /** Fetch events in a date range. start/end are ISO strings. */
    getEvents: (start: string, end: string) => {
      if (USE_MOCK) return delay<any[]>([]);
      return request<any[]>(
        `/calendar/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
      );
    },
    createEvent: (data: {
      title: string;
      description?: string;
      location?: string;
      startAt: string;
      endAt: string;
      allDay?: boolean;
    }) => {
      if (USE_MOCK) return delay({ id: `e-${Date.now()}`, ...data });
      return request<any>('/calendar/events', { method: 'POST', body: JSON.stringify(data) });
    },
    deleteEvent: (id: string) => {
      if (USE_MOCK) return delay({ success: true });
      return request<{ success: boolean }>(`/calendar/events/${id}`, { method: 'DELETE' });
    },
    /**
     * Query the free/busy schedule for any user on the same Zimbra server.
     * start/end are ISO strings covering the window to query.
     */
    getFreeBusy: (email: string, start: string, end: string) => {
      if (USE_MOCK) return delay<{
        email: string;
        busy: Array<{ s: number; e: number }>;
        tentative: Array<{ s: number; e: number }>;
        unavailable: Array<{ s: number; e: number }>;
      }>({ email, busy: [], tentative: [], unavailable: [] });
      return request<{
        email: string;
        busy: Array<{ s: number; e: number }>;
        tentative: Array<{ s: number; e: number }>;
        unavailable: Array<{ s: number; e: number }>;
      }>(
        `/calendar/freebusy?email=${encodeURIComponent(email)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
      );
    },
  },

  auth: {
    login: (email: string, password: string, zimbraHost: string) => {
      if (USE_MOCK)
        return delay({ accessToken: 'mock-token', user: { id: 'u1', email, displayName: 'Demo User', zimbraHost } });
      return request<
        | { accessToken: string; user: any }
        | { requiresTwoFactor: true; twoFactorToken: string }
      >('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password, zimbraHost }),
      });
    },
    twoFactor: (twoFactorToken: string, code: string) => {
      return request<{ accessToken: string; user: any }>('/auth/two-factor', {
        method: 'POST',
        body: JSON.stringify({ twoFactorToken, code }),
      });
    },
    me: () => {
      if (USE_MOCK) return delay({ id: 'u1', email: 'demo@company.com', displayName: 'Demo User', zimbraHost: 'mail.company.com' });
      return request<any>('/auth/me');
    },
    logout: () => {
      if (USE_MOCK) return delay(undefined);
      return request<void>('/auth/logout', { method: 'POST' });
    },
  },

  mail: {
    getFolders: () => {
      if (USE_MOCK) return delay(MOCK_FOLDERS);
      return request<any[]>('/mail/folders');
    },
    getMessages: (folderId: string, limit = 50, offset = 0) => {
      if (USE_MOCK)
        return delay({ messages: MOCK_MESSAGES, total: 120, offset: 0, limit: 50, hasMore: true });
      return request<any>(`/mail/folders/${folderId}/messages?limit=${limit}&offset=${offset}`);
    },
    getMessage: (messageId: string) => {
      if (USE_MOCK)
        return delay(messageId === 'm1' ? MOCK_MESSAGE_DETAIL : MOCK_MESSAGES.find((m) => m.id === messageId) ?? MOCK_MESSAGE_DETAIL);
      return request<any>(`/mail/messages/${messageId}`);
    },
    /** Fetch all messages in the same conversation, ordered oldest → newest.
     *  Body fields are omitted — fetch individual messages via getMessage on expand. */
    getConversation: (messageId: string) => {
      if (USE_MOCK) return delay<{ conversationId: string | null; messages: any[] }>({ conversationId: null, messages: [] });
      return request<{ conversationId: string | null; messages: any[] }>(
        `/mail/messages/${messageId}/conversation`,
      );
    },
    search: (query: string, limit = 50, offset = 0) => {
      if (USE_MOCK) return delay({ messages: MOCK_MESSAGES.filter(m => JSON.stringify(m).toLowerCase().includes(query.toLowerCase())), total: 0, offset: 0, limit: 50, hasMore: false });
      return request<any>(`/mail/search?q=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}`);
    },
    send: (payload: any) => {
      if (USE_MOCK) return delay({ success: true });
      return request<any>('/mail/send', { method: 'POST', body: JSON.stringify(payload) });
    },
    /** Send a message with file attachments using multipart/form-data. */
    sendWithFiles: (payload: any, files: File[]): Promise<any> => {
      if (USE_MOCK) return delay({ success: true });
      const token = getToken();
      const fd = new FormData();
      fd.append('payload', JSON.stringify(payload));
      files.forEach((f) => fd.append('attachments', f, f.name));
      return fetch(`${API_BASE}/mail/send-with-attachments`, {
        method: 'POST',
        // Do NOT set Content-Type — browser sets it with multipart boundary
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      }).then(async (res) => {
        if (!res.ok) {
          if (res.status === 401 && token && typeof window !== 'undefined') {
            localStorage.removeItem('auth');
            window.location.replace('/login');
            throw new Error('Session expired — please log in again');
          }
          const err = await res.json().catch(() => ({ message: res.statusText }));
          throw new Error(err.message ?? 'Request failed');
        }
        return res.json();
      });
    },
    /** Save or update a draft. Pass draftId to update an existing draft. */
    saveDraft: (payload: {
      to?: string[];
      cc?: string[];
      bcc?: string[];
      subject?: string;
      body?: string;
      draftId?: string;
    }) => {
      if (USE_MOCK) return delay({ zimbraId: `draft-${Date.now()}` });
      return request<{ zimbraId: string }>('/mail/drafts', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },
    /** Discard (move to trash) an auto-saved draft. */
    discardDraft: (zimbraId: string) => {
      if (USE_MOCK) return delay({ success: true });
      return request<{ success: boolean }>(
        `/mail/drafts/${encodeURIComponent(zimbraId)}`,
        { method: 'DELETE' },
      );
    },
    delete: (messageId: string) => {
      if (USE_MOCK) return delay({ success: true });
      return request<any>(`/mail/messages/${messageId}`, { method: 'DELETE' });
    },
    markRead: (messageId: string, read: boolean) => {
      if (USE_MOCK) return delay({ success: true });
      return request<any>(`/mail/messages/${messageId}/read`, {
        method: 'PATCH',
        body: JSON.stringify({ read }),
      });
    },
    moveMessage: (messageId: string, folderId: string) => {
      if (USE_MOCK) return delay({ success: true });
      return request<any>(`/mail/messages/${messageId}/move`, {
        method: 'PATCH',
        body: JSON.stringify({ folderId }),
      });
    },
    createFolder: (name: string) => {
      if (USE_MOCK) return delay({ id: `f-${Date.now()}`, name, path: `/${name}`, unreadCount: 0, totalCount: 0 });
      return request<any>('/mail/folders', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
    },
    deleteFolder: (folderId: string) => {
      if (USE_MOCK) return delay({ success: true });
      return request<any>(`/mail/folders/${folderId}`, { method: 'DELETE' });
    },
    /**
     * Download an attachment and return a blob object-URL.
     * The caller must call URL.revokeObjectURL(url) when the download is done.
     */
    downloadAttachment: async (messageId: string, partId: string): Promise<string> => {
      if (USE_MOCK) return '';
      const token = getToken();
      const res = await fetch(
        `${API_BASE}/mail/messages/${messageId}/attachments/${encodeURIComponent(partId)}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      if (!res.ok) throw new Error('Failed to download attachment');
      const blob = await res.blob();
      return URL.createObjectURL(blob);
    },
  },

  settings: {
    /**
     * GET /settings
     * Fetches prefs, identities, signatures and basic profile in one shot.
     */
    get: () => {
      if (USE_MOCK) return delay<any>({ email: '', zimbraHost: '', displayName: '', prefs: {}, identities: [], signatures: [] });
      return request<{
        email: string;
        zimbraHost: string;
        displayName: string | null;
        prefs: Record<string, string>;
        identities: Array<{ id: string; name: string; attrs: Record<string, string> }>;
        signatures: Array<{ id: string; name: string; contentHtml: string; contentText: string }>;
      }>('/settings');
    },

    /** PATCH /settings/prefs — update one or more Zimbra preference keys */
    updatePrefs: (prefs: Record<string, string>) => {
      if (USE_MOCK) return delay({ success: true });
      return request<{ success: boolean }>('/settings/prefs', {
        method: 'PATCH',
        body: JSON.stringify(prefs),
      });
    },

    /** PATCH /settings/identity/:id — update identity attributes */
    updateIdentity: (identityId: string, attrs: Record<string, string>) => {
      if (USE_MOCK) return delay({ success: true });
      return request<{ success: boolean }>(`/settings/identity/${identityId}`, {
        method: 'PATCH',
        body: JSON.stringify(attrs),
      });
    },

    /** POST /settings/signatures — create a new email signature */
    createSignature: (data: { name: string; contentHtml: string }) => {
      if (USE_MOCK) return delay({ id: `sig-${Date.now()}`, name: data.name, contentHtml: data.contentHtml, contentText: '', imagesStripped: false });
      return request<{ id: string; name: string; contentHtml: string; contentText: string; imagesStripped?: boolean }>(
        '/settings/signatures',
        { method: 'POST', body: JSON.stringify(data) },
      );
    },

    /** PATCH /settings/signatures/:id — update an existing email signature */
    updateSignature: (id: string, data: { name: string; contentHtml: string }) => {
      if (USE_MOCK) return delay({ id, name: data.name, contentHtml: data.contentHtml, contentText: '', imagesStripped: false });
      return request<{ id: string; name: string; contentHtml: string; contentText: string; imagesStripped?: boolean }>(
        `/settings/signatures/${id}`,
        { method: 'PATCH', body: JSON.stringify(data) },
      );
    },

    /** DELETE /settings/signatures/:id — delete an email signature */
    deleteSignature: (id: string) => {
      if (USE_MOCK) return delay({ success: true });
      return request<{ success: boolean }>(`/settings/signatures/${id}`, { method: 'DELETE' });
    },

    /** POST /settings/password — change the user's Zimbra password */
    changePassword: (oldPassword: string, newPassword: string) => {
      if (USE_MOCK) return delay({ success: true });
      return request<{ success: boolean }>('/settings/password', {
        method: 'POST',
        body: JSON.stringify({ oldPassword, newPassword }),
      });
    },
  },
};
