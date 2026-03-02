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
    groups: {
      getAll: () => {
        if (USE_MOCK) return delay<any[]>([]);
        return request<any[]>('/contacts/groups');
      },
      create: (data: { name: string; description?: string; members?: { email: string; name?: string }[] }) => {
        if (USE_MOCK) return delay({ id: `g-${Date.now()}`, ...data });
        return request<any>('/contacts/groups', { method: 'POST', body: JSON.stringify(data) });
      },
      update: (id: string, data: { name?: string; description?: string; members?: { email: string; name?: string }[] }) => {
        if (USE_MOCK) return delay({ id, ...data });
        return request<any>(`/contacts/groups/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
      },
      delete: (id: string) => {
        if (USE_MOCK) return delay({ success: true });
        return request<{ success: boolean }>(`/contacts/groups/${id}`, { method: 'DELETE' });
      },
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
    /** Fetch full event details from Zimbra (complete attendee list). */
    getEvent: (id: string) => {
      if (USE_MOCK) return delay<any>(null);
      return request<any>(`/calendar/events/${id}`);
    },
    createEvent: (data: {
      title: string;
      description?: string;
      location?: string;
      startAt: string;
      endAt: string;
      allDay?: boolean;
      attendees?: string[];
    }) => {
      if (USE_MOCK) return delay({ id: `e-${Date.now()}`, ...data });
      return request<any>('/calendar/events', { method: 'POST', body: JSON.stringify(data) });
    },
    updateEvent: (id: string, data: {
      title: string;
      description?: string;
      location?: string;
      startAt: string;
      endAt: string;
      allDay?: boolean;
      attendees?: string[];
    }) => {
      if (USE_MOCK) return delay({ id, ...data });
      return request<any>(`/calendar/events/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
    },
    deleteEvent: (id: string) => {
      if (USE_MOCK) return delay({ success: true });
      return request<{ success: boolean }>(`/calendar/events/${id}`, { method: 'DELETE' });
    },
    rsvp: (id: string, verb: 'ACCEPT' | 'DECLINE' | 'TENTATIVE') => {
      if (USE_MOCK) return delay({ success: true });
      return request<{ success: boolean }>(`/calendar/events/${id}/rsvp`, {
        method: 'POST',
        body: JSON.stringify({ verb }),
      });
    },
    /** Batch free/busy: query multiple users in one request (parallel Zimbra calls on server). */
    getFreeBusyBatch: (emails: string[], start: string, end: string) => {
      if (USE_MOCK) return delay<any[]>(emails.map((email) => ({ email, busy: [], tentative: [], unavailable: [] })));
      return request<any[]>('/calendar/freebusy/batch', {
        method: 'POST',
        body: JSON.stringify({ emails, start, end }),
      });
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

    // ── Snooze ────────────────────────────────────────────────────────────────
    snooze: (messageId: string, snoozedUntil: string, originalFolderId: string) => {
      if (USE_MOCK) return delay({ success: true });
      return request<any>('/mail/snooze', { method: 'POST', body: JSON.stringify({ messageId, snoozedUntil, originalFolderId }) });
    },
    unsnooze: (messageId: string) => {
      if (USE_MOCK) return delay({ success: true });
      return request<any>(`/mail/snooze/${messageId}`, { method: 'DELETE' });
    },
    getSnoozed: () => {
      if (USE_MOCK) return delay<any[]>([]);
      return request<any[]>('/mail/snoozed');
    },

    // ── Scheduled Send ────────────────────────────────────────────────────────
    scheduleMessage: (payload: { sendAt: string; to: string[]; cc?: string[]; bcc?: string[]; subject?: string; body?: string }) => {
      if (USE_MOCK) return delay({ id: `sched-${Date.now()}`, ...payload, status: 'PENDING' });
      return request<any>('/mail/scheduled', { method: 'POST', body: JSON.stringify(payload) });
    },
    cancelScheduled: (id: string) => {
      if (USE_MOCK) return delay({ success: true });
      return request<any>(`/mail/scheduled/${id}`, { method: 'DELETE' });
    },
    getScheduled: () => {
      if (USE_MOCK) return delay<any[]>([]);
      return request<any[]>('/mail/scheduled');
    },

    // ── Templates ─────────────────────────────────────────────────────────────
    getTemplates: () => {
      if (USE_MOCK) return delay<any[]>([]);
      return request<any[]>('/mail/templates');
    },
    createTemplate: (data: { name: string; subject?: string; body: string }) => {
      if (USE_MOCK) return delay({ id: `tmpl-${Date.now()}`, ...data });
      return request<any>('/mail/templates', { method: 'POST', body: JSON.stringify(data) });
    },
    updateTemplate: (id: string, data: { name?: string; subject?: string; body?: string }) => {
      if (USE_MOCK) return delay({ id, ...data });
      return request<any>(`/mail/templates/${id}`, { method: 'PUT', body: JSON.stringify(data) });
    },
    deleteTemplate: (id: string) => {
      if (USE_MOCK) return delay({ success: true });
      return request<any>(`/mail/templates/${id}`, { method: 'DELETE' });
    },

    // ── Rules ─────────────────────────────────────────────────────────────────
    getRules: () => {
      if (USE_MOCK) return delay<any[]>([]);
      return request<any[]>('/mail/rules');
    },
    createRule: (data: { name: string; enabled?: boolean; conditions: any[]; actions: any[] }) => {
      if (USE_MOCK) return delay({ id: `rule-${Date.now()}`, ...data });
      return request<any>('/mail/rules', { method: 'POST', body: JSON.stringify(data) });
    },
    updateRule: (id: string, data: Partial<{ name: string; enabled: boolean; conditions: any[]; actions: any[] }>) => {
      if (USE_MOCK) return delay({ id, ...data });
      return request<any>(`/mail/rules/${id}`, { method: 'PUT', body: JSON.stringify(data) });
    },
    deleteRule: (id: string) => {
      if (USE_MOCK) return delay({ success: true });
      return request<any>(`/mail/rules/${id}`, { method: 'DELETE' });
    },

    // ── Mute ──────────────────────────────────────────────────────────────────
    muteConversation: (conversationId: string) => {
      if (USE_MOCK) return delay({ success: true, muted: true });
      return request<any>(`/mail/mute/${conversationId}`, { method: 'POST' });
    },
    unmuteConversation: (conversationId: string) => {
      if (USE_MOCK) return delay({ success: true, muted: false });
      return request<any>(`/mail/mute/${conversationId}`, { method: 'DELETE' });
    },
    getMuted: () => {
      if (USE_MOCK) return delay<string[]>([]);
      return request<string[]>('/mail/muted');
    },

    // ── Bulk ──────────────────────────────────────────────────────────────────
    bulkMarkRead: (messageIds: string[], read: boolean) => {
      if (USE_MOCK) return delay({ results: messageIds.map((id) => ({ id, success: true })) });
      return request<any>('/mail/bulk/mark-read', { method: 'POST', body: JSON.stringify({ messageIds, read }) });
    },
    bulkDelete: (messageIds: string[]) => {
      if (USE_MOCK) return delay({ results: messageIds.map((id) => ({ id, success: true })) });
      return request<any>('/mail/bulk/delete', { method: 'POST', body: JSON.stringify({ messageIds }) });
    },
    bulkMove: (messageIds: string[], folderId: string) => {
      if (USE_MOCK) return delay({ results: messageIds.map((id) => ({ id, success: true })) });
      return request<any>('/mail/bulk/move', { method: 'POST', body: JSON.stringify({ messageIds, folderId }) });
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

  tasks: {
    getAll: (status?: string, linkedMessageId?: string) => {
      if (USE_MOCK) return delay<any[]>([]);
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (linkedMessageId) params.set('linkedMessageId', linkedMessageId);
      const qs = params.toString();
      return request<any[]>(`/tasks${qs ? `?${qs}` : ''}`);
    },
    create: (data: {
      title: string;
      description?: string;
      status?: string;
      priority?: string;
      dueDate?: string;
      linkedMessageId?: string;
      linkedSubject?: string;
      assignedToEmail?: string;
      assignedToName?: string;
      recurrence?: string;
      recurrenceEndDate?: string;
      reminderAt?: string;
    }) => {
      if (USE_MOCK) return delay({ id: `t-${Date.now()}`, ...data });
      return request<any>('/tasks', { method: 'POST', body: JSON.stringify(data) });
    },
    update: (id: string, data: Partial<{
      title: string;
      description: string;
      status: string;
      priority: string;
      dueDate: string;
      linkedMessageId: string;
      linkedSubject: string;
      assignedToEmail: string;
      assignedToName: string;
      recurrence: string;
      recurrenceEndDate: string;
      reminderAt: string;
    }>) => {
      if (USE_MOCK) return delay({ id, ...data });
      return request<any>(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
    },
    delete: (id: string) => {
      if (USE_MOCK) return delay({ success: true });
      return request<{ success: boolean }>(`/tasks/${id}`, { method: 'DELETE' });
    },
    assign: (id: string, assigneeEmail: string, assigneeName?: string) => {
      if (USE_MOCK) return delay({ id, assignedToEmail: assigneeEmail, assignedToName: assigneeName });
      return request<any>(`/tasks/${id}/assign`, {
        method: 'POST',
        body: JSON.stringify({ assigneeEmail, assigneeName }),
      });
    },
    createSubtask: (taskId: string, title: string) => {
      if (USE_MOCK) return delay({ id: `s-${Date.now()}`, taskId, title, completed: false, createdAt: new Date().toISOString() });
      return request<any>(`/tasks/${taskId}/subtasks`, { method: 'POST', body: JSON.stringify({ title }) });
    },
    updateSubtask: (taskId: string, subtaskId: string, data: { title?: string; completed?: boolean }) => {
      if (USE_MOCK) return delay({ id: subtaskId, taskId, ...data });
      return request<any>(`/tasks/${taskId}/subtasks/${subtaskId}`, { method: 'PATCH', body: JSON.stringify(data) });
    },
    deleteSubtask: (taskId: string, subtaskId: string) => {
      if (USE_MOCK) return delay({ success: true });
      return request<{ success: boolean }>(`/tasks/${taskId}/subtasks/${subtaskId}`, { method: 'DELETE' });
    },
    createComment: (taskId: string, body: string) => {
      if (USE_MOCK) return delay({ id: `c-${Date.now()}`, taskId, body, createdAt: new Date().toISOString() });
      return request<any>(`/tasks/${taskId}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
    },
    deleteComment: (taskId: string, commentId: string) => {
      if (USE_MOCK) return delay({ success: true });
      return request<{ success: boolean }>(`/tasks/${taskId}/comments/${commentId}`, { method: 'DELETE' });
    },

    // ─── Attachments ───────────────────────────────────────────────────────────

    uploadAttachments: (taskId: string, files: File[]): Promise<any> => {
      if (USE_MOCK) return delay({});
      const token = getToken();
      const fd = new FormData();
      files.forEach((f) => fd.append('attachments', f, f.name));
      return fetch(`${API_BASE}/tasks/${taskId}/attachments`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      }).then(async (res) => {
        if (!res.ok) {
          if (res.status === 401 && typeof window !== 'undefined') {
            localStorage.removeItem('auth');
            window.location.replace('/login');
            throw new Error('Session expired');
          }
          const err = await res.json().catch(() => ({}));
          throw new Error((err as any).message ?? 'Upload failed');
        }
        return res.json();
      });
    },

    deleteAttachment: (taskId: string, attId: string) => {
      if (USE_MOCK) return delay({ success: true });
      return request<{ success: boolean }>(`/tasks/${taskId}/attachments/${attId}`, { method: 'DELETE' });
    },

    downloadAttachment: async (taskId: string, attId: string): Promise<string> => {
      if (USE_MOCK) return '';
      const token = getToken();
      const res = await fetch(`${API_BASE}/tasks/${taskId}/attachments/${attId}/download`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error('Download failed');
      return URL.createObjectURL(await res.blob());
    },
  },

  notifications: {
    getAll: (limit = 50) => {
      if (USE_MOCK) return delay<any[]>([]);
      return request<any[]>(`/notifications?limit=${limit}`);
    },
    getUnreadCount: () => {
      if (USE_MOCK) return delay({ count: 0 });
      return request<{ count: number }>('/notifications/unread-count');
    },
    markRead: (id: string) => {
      if (USE_MOCK) return delay({});
      return request<any>(`/notifications/${id}/read`, { method: 'PATCH' });
    },
    markAllRead: () => {
      if (USE_MOCK) return delay({});
      return request<any>('/notifications/read-all', { method: 'PATCH' });
    },
    delete: (id: string) => {
      if (USE_MOCK) return delay({ success: true });
      return request<{ success: boolean }>(`/notifications/${id}`, { method: 'DELETE' });
    },
  },

  docs: {
    getAll: () => {
      if (USE_MOCK) return delay<Doc[]>([]);
      return request<Doc[]>('/docs');
    },
    getOne: (id: string) => {
      if (USE_MOCK) return delay<Doc>({ id, title: 'Untitled', emoji: null, position: 0, shareToken: null, isShared: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      return request<Doc>(`/docs/${id}`);
    },
    create: (data?: { title?: string; emoji?: string }) => {
      if (USE_MOCK) return delay<Doc>({ id: `mock-${Date.now()}`, title: data?.title ?? 'Untitled', emoji: data?.emoji ?? null, position: 0, shareToken: null, isShared: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      return request<Doc>('/docs', { method: 'POST', body: JSON.stringify(data ?? {}) });
    },
    update: (id: string, data: Partial<{ title: string; content: string; emoji: string; position: number }>) => {
      if (USE_MOCK) return delay<Doc>({ id, title: 'Untitled', emoji: null, position: 0, shareToken: null, isShared: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      return request<Doc>(`/docs/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
    },
    delete: (id: string) => {
      if (USE_MOCK) return delay({ success: true });
      return request<{ success: boolean }>(`/docs/${id}`, { method: 'DELETE' });
    },
    share: {
      enable:  (id: string) => request<{ shareToken: string; isShared: boolean }>(`/docs/${id}/share`, { method: 'POST' }),
      disable: (id: string) => request<{ shareToken: null; isShared: false }>(`/docs/${id}/share`, { method: 'DELETE' }),
    },
  },

  shared: {
    getOne: (token: string) => request<Doc>(`/docs/shared/${token}`),
    update: (token: string, data: Partial<{ title: string; content: string }>) =>
      request<Doc>(`/docs/shared/${token}`, { method: 'PATCH', body: JSON.stringify(data) }),
  },
};

export interface Doc {
  id: string;
  title: string;
  emoji: string | null;
  content?: string;
  position: number;
  shareToken: string | null;
  isShared: boolean;
  createdAt: string;
  updatedAt: string;
}
