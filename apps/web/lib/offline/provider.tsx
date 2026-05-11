'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';
import { OfflineDB, type OutboxOp } from './db';
import { Outbox } from './outbox';
import { Runner, browserConnectivity, browserScheduler, type Handler } from './runner';
import { MailCache } from './mailCache';

export interface EnqueueArgs<P = unknown> {
  kind: string;
  payload: P;
  idempotencyKey?: string;
  maxAttempts?: number;
  onFailed?: (error: string, op: OutboxOp) => void;
}

export interface OfflineStatus {
  pending: number;
  failed: number;
  online: boolean;
}

export interface MailCacheRef {
  setFolderPage(folderId: string, data: unknown): Promise<void>;
  getFolderPage(folderId: string): Promise<unknown | undefined>;
  setMessage(id: string, data: unknown): Promise<void>;
  getMessage(id: string): Promise<unknown | undefined>;
}

interface OfflineContextValue {
  enqueue<P = unknown>(args: EnqueueArgs<P>): Promise<string>;
  mail: MailCacheRef;
  status: OfflineStatus;
}

const OfflineContext = createContext<OfflineContextValue | null>(null);

interface MailMovePayload {
  messageId: string;
  folderId: string;
}
interface MailDeletePayload {
  messageId: string;
}
interface MailMarkReadPayload {
  messageId: string;
  read: boolean;
}
interface MailBulkDeletePayload {
  messageIds: string[];
}
interface MailBulkMovePayload {
  messageIds: string[];
  folderId: string;
}
interface MailBulkMarkReadPayload {
  messageIds: string[];
  read: boolean;
}

const HANDLERS: Record<string, Handler> = {
  'mail.move': (async (p: MailMovePayload) => {
    await api.mail.moveMessage(p.messageId, p.folderId);
  }) as Handler,
  'mail.delete': (async (p: MailDeletePayload) => {
    await api.mail.delete(p.messageId);
  }) as Handler,
  'mail.markRead': (async (p: MailMarkReadPayload) => {
    await api.mail.markRead(p.messageId, p.read);
  }) as Handler,
  'mail.bulkDelete': (async (p: MailBulkDeletePayload) => {
    await api.mail.bulkDelete(p.messageIds);
  }) as Handler,
  'mail.bulkMove': (async (p: MailBulkMovePayload) => {
    await api.mail.bulkMove(p.messageIds, p.folderId);
  }) as Handler,
  'mail.bulkMarkRead': (async (p: MailBulkMarkReadPayload) => {
    await api.mail.bulkMarkRead(p.messageIds, p.read);
  }) as Handler,
};

interface Stack {
  db: OfflineDB;
  outbox: Outbox;
  runner: Runner;
  cache: MailCache;
}

const MESSAGE_CACHE_CAP = 200;

export function OfflineProvider({ children }: { children: ReactNode }) {
  const userId = useAuthStore((s) => s.user?.id);

  const [status, setStatus] = useState<OfflineStatus>({
    pending: 0,
    failed: 0,
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
  });

  const stackRef = useRef<Stack | null>(null);
  const onFailedById = useRef(new Map<string, (err: string, op: OutboxOp) => void>());
  const handledFailedIds = useRef(new Set<string>());
  const onChangeRef = useRef<() => void>(() => {});

  const reconcile = useCallback(async () => {
    const stack = stackRef.current;
    if (!stack) {
      setStatus((prev) => {
        const online = browserConnectivity.isOnline();
        if (prev.pending === 0 && prev.failed === 0 && prev.online === online) return prev;
        return { pending: 0, failed: 0, online };
      });
      return;
    }

    const [pending, failed] = await Promise.all([
      stack.outbox.list({ status: 'pending' }),
      stack.outbox.list({ status: 'failed' }),
    ]);

    for (const op of failed) {
      if (handledFailedIds.current.has(op.id)) continue;
      handledFailedIds.current.add(op.id);
      const cb = onFailedById.current.get(op.id);
      onFailedById.current.delete(op.id);
      try {
        cb?.(op.lastError ?? 'Unknown error', op);
      } finally {
        await stack.outbox.markDone(op.id);
        handledFailedIds.current.delete(op.id);
      }
    }

    setStatus((prev) => {
      const online = browserConnectivity.isOnline();
      const next: OfflineStatus = { pending: pending.length, failed: failed.length, online };
      if (
        prev.pending === next.pending &&
        prev.failed === next.failed &&
        prev.online === next.online
      ) {
        return prev;
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!userId) {
      stackRef.current = null;
      onFailedById.current.clear();
      handledFailedIds.current.clear();
      void reconcile();
      return;
    }

    const db = new OfflineDB(`offline-mail-${userId}`);
    const outbox = new Outbox(db);
    const cache = new MailCache(db);
    const runner = new Runner(outbox, {
      connectivity: browserConnectivity,
      scheduler: browserScheduler,
      onChange: () => onChangeRef.current(),
    });
    for (const [kind, handler] of Object.entries(HANDLERS)) {
      runner.register(kind, handler);
    }
    stackRef.current = { db, outbox, runner, cache };

    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      void reconcile();
    };
    onChangeRef.current = tick;
    const unsub = browserConnectivity.subscribe(() => tick());

    void runner.start().then(() => {
      if (!cancelled) tick();
    });

    return () => {
      cancelled = true;
      onChangeRef.current = () => {};
      unsub();
      void runner.stop().then(() => db.close());
      if (stackRef.current?.runner === runner) {
        stackRef.current = null;
      }
    };
  }, [userId, reconcile]);

  const enqueue = useCallback(
    async <P,>(args: EnqueueArgs<P>) => {
      const stack = stackRef.current;
      if (!stack) {
        throw new Error('Offline outbox is unavailable: no authenticated user.');
      }
      const id = await stack.outbox.enqueue(args.kind, args.payload, {
        idempotencyKey: args.idempotencyKey,
        maxAttempts: args.maxAttempts,
      });
      if (args.onFailed) onFailedById.current.set(id, args.onFailed as never);
      stack.runner.notify();
      void reconcile();
      return id;
    },
    [reconcile],
  );

  const mail = useMemo<MailCacheRef>(
    () => ({
      async setFolderPage(folderId, data) {
        const stack = stackRef.current;
        if (!stack) return;
        await stack.cache.setFolderPage(folderId, data);
      },
      async getFolderPage(folderId) {
        const stack = stackRef.current;
        if (!stack) return undefined;
        const row = await stack.cache.getFolderPage(folderId);
        return row?.data;
      },
      async setMessage(id, data) {
        const stack = stackRef.current;
        if (!stack) return;
        await stack.cache.setMessage(id, data);
        await stack.cache.evictOldMessages(MESSAGE_CACHE_CAP);
      },
      async getMessage(id) {
        const stack = stackRef.current;
        if (!stack) return undefined;
        const row = await stack.cache.getMessage(id);
        return row?.data;
      },
    }),
    [],
  );

  const value = useMemo<OfflineContextValue>(
    () => ({ enqueue, mail, status }),
    [enqueue, mail, status],
  );

  return <OfflineContext.Provider value={value}>{children}</OfflineContext.Provider>;
}

export function useOffline(): OfflineContextValue {
  const ctx = useContext(OfflineContext);
  if (!ctx) throw new Error('useOffline must be used inside <OfflineProvider>');
  return ctx;
}
