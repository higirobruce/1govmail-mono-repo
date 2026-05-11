import type { OfflineDB, OutboxOp, OutboxStatus } from './db';

export interface EnqueueOptions {
  maxAttempts?: number;
  idempotencyKey?: string;
}

export interface OutboxDeps {
  now?: () => number;
  randomId?: () => string;
  random?: () => number;
}

export interface ListFilter {
  status?: OutboxStatus;
  kind?: string;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 5 * 60 * 1_000;

export class Outbox {
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly random: () => number;

  constructor(private readonly db: OfflineDB, deps: OutboxDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.randomId = deps.randomId ?? (() => crypto.randomUUID());
    this.random = deps.random ?? Math.random;
  }

  async enqueue(kind: string, payload: unknown, opts: EnqueueOptions = {}): Promise<string> {
    const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const idempotencyKey = opts.idempotencyKey;

    if (idempotencyKey) {
      const existing = await this.db.outbox
        .where('idempotencyKey')
        .equals(idempotencyKey)
        .filter((op) => op.status !== 'failed')
        .first();
      if (existing) return existing.id;
    }

    const ts = this.now();
    const op: OutboxOp = {
      id: this.randomId(),
      kind,
      payload,
      status: 'pending',
      attempts: 0,
      maxAttempts,
      createdAt: ts,
      scheduledAt: ts,
      idempotencyKey,
    };
    await this.db.outbox.add(op);
    return op.id;
  }

  async peekReady(limit = 10): Promise<OutboxOp[]> {
    const now = this.now();
    return this.db.outbox
      .where('[status+scheduledAt]')
      .between(['pending', 0], ['pending', now], true, true)
      .limit(limit)
      .toArray();
  }

  async markRunning(id: string): Promise<void> {
    await this.db.outbox.update(id, { status: 'running' });
  }

  async markDone(id: string): Promise<void> {
    await this.db.outbox.delete(id);
  }

  async markFailed(id: string, error: unknown): Promise<void> {
    const op = await this.db.outbox.get(id);
    if (!op) return;

    const message = error instanceof Error ? error.message : String(error);
    const attempts = op.attempts + 1;

    if (attempts >= op.maxAttempts) {
      await this.db.outbox.update(id, {
        status: 'failed',
        attempts,
        lastError: message,
      });
      return;
    }

    const exp = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** op.attempts);
    const jitter = Math.floor(this.random() * BASE_BACKOFF_MS);
    await this.db.outbox.update(id, {
      status: 'pending',
      attempts,
      lastError: message,
      scheduledAt: this.now() + exp + jitter,
    });
  }

  async get(id: string): Promise<OutboxOp | undefined> {
    return this.db.outbox.get(id);
  }

  async nextScheduledAt(): Promise<number | undefined> {
    const next = await this.db.outbox
      .where('[status+scheduledAt]')
      .between(['pending', 0], ['pending', Number.MAX_SAFE_INTEGER], true, true)
      .first();
    return next?.scheduledAt;
  }

  async recoverRunning(): Promise<number> {
    return this.db.outbox
      .where('[status+scheduledAt]')
      .between(['running', 0], ['running', Number.MAX_SAFE_INTEGER], true, true)
      .modify({ status: 'pending' });
  }

  async list(filter: ListFilter = {}): Promise<OutboxOp[]> {
    let coll = this.db.outbox.toCollection();
    if (filter.status) coll = coll.filter((op) => op.status === filter.status);
    if (filter.kind) coll = coll.filter((op) => op.kind === filter.kind);
    return coll.toArray();
  }

  async clear(): Promise<void> {
    await this.db.outbox.clear();
  }
}
