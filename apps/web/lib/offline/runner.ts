import type { OutboxOp } from './db';
import type { Outbox } from './outbox';

export interface Connectivity {
  isOnline(): boolean;
  subscribe(listener: (online: boolean) => void): () => void;
}

export interface Scheduler {
  schedule(fn: () => void, delayMs: number): () => void;
}

export type Handler<P = unknown> = (payload: P, op: OutboxOp) => Promise<void>;

export interface RunnerOptions {
  connectivity?: Connectivity;
  scheduler?: Scheduler;
  batchSize?: number;
  onChange?: () => void;
  now?: () => number;
}

export const browserConnectivity: Connectivity = {
  isOnline: () => (typeof navigator === 'undefined' ? true : navigator.onLine),
  subscribe: (listener) => {
    if (typeof window === 'undefined') return () => {};
    const onUp = () => listener(true);
    const onDown = () => listener(false);
    window.addEventListener('online', onUp);
    window.addEventListener('offline', onDown);
    return () => {
      window.removeEventListener('online', onUp);
      window.removeEventListener('offline', onDown);
    };
  },
};

export const browserScheduler: Scheduler = {
  schedule: (fn, ms) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
};

export class Runner {
  private readonly handlers = new Map<string, Handler>();
  private readonly connectivity: Connectivity;
  private readonly scheduler: Scheduler;
  private readonly batchSize: number;
  private readonly onChange: () => void;
  private readonly now: () => number;

  private started = false;
  private drainPromise: Promise<void> | null = null;
  private cancelTimer: (() => void) | null = null;
  private unsubConnectivity: (() => void) | null = null;

  constructor(private readonly outbox: Outbox, opts: RunnerOptions = {}) {
    this.connectivity = opts.connectivity ?? browserConnectivity;
    this.scheduler = opts.scheduler ?? browserScheduler;
    this.batchSize = opts.batchSize ?? 10;
    this.onChange = opts.onChange ?? (() => {});
    this.now = opts.now ?? Date.now;
  }

  register<P = unknown>(kind: string, handler: Handler<P>): void {
    this.handlers.set(kind, handler as Handler);
  }

  unregister(kind: string): void {
    this.handlers.delete(kind);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.outbox.recoverRunning();

    this.unsubConnectivity = this.connectivity.subscribe((online) => {
      if (online && this.started) void this.flush();
    });

    await this.flush();
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.unsubConnectivity) {
      this.unsubConnectivity();
      this.unsubConnectivity = null;
    }
    this.cancelPendingTimer();
    if (this.drainPromise) await this.drainPromise;
  }

  notify(): void {
    if (!this.started) return;
    void this.flush();
  }

  flush(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.cancelPendingTimer();
    const work = this.runDrain().finally(() => this.scheduleNext());
    this.drainPromise = work;
    work.finally(() => {
      if (this.drainPromise === work) this.drainPromise = null;
    });
    return work;
  }

  private async runDrain(): Promise<void> {
    while (this.connectivity.isOnline()) {
      const batch = await this.outbox.peekReady(this.batchSize);
      if (batch.length === 0) return;
      for (const op of batch) {
        if (!this.connectivity.isOnline()) return;
        await this.processOne(op);
      }
    }
  }

  private async processOne(op: OutboxOp): Promise<void> {
    const handler = this.handlers.get(op.kind);
    if (!handler) {
      await this.outbox.markFailed(op.id, new Error(`No handler registered for kind "${op.kind}"`));
      this.onChange();
      return;
    }
    await this.outbox.markRunning(op.id);
    try {
      await handler(op.payload, op);
      await this.outbox.markDone(op.id);
    } catch (err) {
      await this.outbox.markFailed(op.id, err);
    }
    this.onChange();
  }

  private async scheduleNext(): Promise<void> {
    if (!this.started) return;
    const next = await this.outbox.nextScheduledAt();
    if (next === undefined) return;
    const delay = Math.max(0, next - this.now());
    this.cancelPendingTimer();
    this.cancelTimer = this.scheduler.schedule(() => {
      this.cancelTimer = null;
      void this.flush();
    }, delay);
  }

  private cancelPendingTimer(): void {
    if (this.cancelTimer) {
      this.cancelTimer();
      this.cancelTimer = null;
    }
  }
}
