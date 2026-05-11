import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OfflineDB } from './db';
import { Outbox } from './outbox';
import {
  Runner,
  browserConnectivity,
  browserScheduler,
  type Connectivity,
  type Scheduler,
} from './runner';

class FakeConnectivity implements Connectivity {
  online = true;
  private listeners = new Set<(o: boolean) => void>();
  isOnline = () => this.online;
  subscribe = (listener: (online: boolean) => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  set(value: boolean) {
    this.online = value;
    for (const l of this.listeners) l(value);
  }
}

interface ScheduledTask {
  fn: () => void;
  delay: number;
  cancelled: boolean;
}

class FakeScheduler implements Scheduler {
  tasks: ScheduledTask[] = [];
  schedule = (fn: () => void, delay: number) => {
    const task: ScheduledTask = { fn, delay, cancelled: false };
    this.tasks.push(task);
    return () => {
      task.cancelled = true;
    };
  };
  fireAll() {
    const ready = this.tasks.filter((t) => !t.cancelled);
    this.tasks = [];
    for (const t of ready) t.fn();
  }
  pending() {
    return this.tasks.filter((t) => !t.cancelled);
  }
}

function counterId(prefix = 'op') {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

describe('Runner', () => {
  let db: OfflineDB;
  let outbox: Outbox;
  let conn: FakeConnectivity;
  let sched: FakeScheduler;
  let clock: { t: number };
  const now = () => clock.t;

  beforeEach(async () => {
    db = new OfflineDB(`runner-${crypto.randomUUID()}`);
    await db.open();
    clock = { t: 1_000 };
    outbox = new Outbox(db, { randomId: counterId(), random: () => 0, now });
    conn = new FakeConnectivity();
    sched = new FakeScheduler();
  });

  afterEach(() => {
    db.close();
  });

  it('dispatches a ready op via the registered handler and marks it done', async () => {
    const runner = new Runner(outbox, { connectivity: conn, scheduler: sched });
    const handler = vi.fn(async () => {});
    runner.register('mail.send', handler);

    const id = await outbox.enqueue('mail.send', { to: 'a@b.c' });
    await runner.flush();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ to: 'a@b.c' }, expect.objectContaining({ id, kind: 'mail.send' }));
    expect(await outbox.get(id)).toBeUndefined();
  });

  it('dispatches in FIFO order', async () => {
    const runner = new Runner(outbox, { connectivity: conn, scheduler: sched });
    const seen: string[] = [];
    runner.register('k', async (p: { tag: string }) => {
      seen.push(p.tag);
    });

    await outbox.enqueue('k', { tag: 'a' });
    await outbox.enqueue('k', { tag: 'b' });
    await outbox.enqueue('k', { tag: 'c' });

    await runner.flush();
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('marks an op failed when the handler throws', async () => {
    const runner = new Runner(outbox, { connectivity: conn, scheduler: sched });
    runner.register('k', async () => {
      throw new Error('boom');
    });

    const id = await outbox.enqueue('k', {});
    await runner.flush();

    const op = await outbox.get(id);
    expect(op).toMatchObject({ status: 'pending', attempts: 1, lastError: 'boom' });
  });

  it('skips draining when offline', async () => {
    conn.online = false;
    const runner = new Runner(outbox, { connectivity: conn, scheduler: sched });
    const handler = vi.fn(async () => {});
    runner.register('k', handler);

    await outbox.enqueue('k', {});
    await runner.flush();

    expect(handler).not.toHaveBeenCalled();
    expect(await outbox.list({ status: 'pending' })).toHaveLength(1);
  });

  it('drains automatically when connectivity flips back to online', async () => {
    conn.online = false;
    const runner = new Runner(outbox, { connectivity: conn, scheduler: sched });
    const handler = vi.fn(async () => {});
    runner.register('k', handler);
    await runner.start();

    const id = await outbox.enqueue('k', {});
    expect(handler).not.toHaveBeenCalled();

    conn.set(true);
    await runner.flush();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(await outbox.get(id)).toBeUndefined();
    await runner.stop();
  });

  it('marks ops with unknown kind as failed', async () => {
    const runner = new Runner(outbox, { connectivity: conn, scheduler: sched });

    const id = await outbox.enqueue('mystery', {});
    await runner.flush();

    const op = await outbox.get(id);
    expect(op).toMatchObject({ status: 'pending', attempts: 1 });
    expect(op!.lastError).toMatch(/no handler/i);
  });

  it('recovers running ops to pending on start', async () => {
    const id = await outbox.enqueue('k', {});
    await outbox.markRunning(id);

    const runner = new Runner(outbox, { connectivity: conn, scheduler: sched });
    const handler = vi.fn(async () => {});
    runner.register('k', handler);

    await runner.start();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(await outbox.get(id)).toBeUndefined();
    await runner.stop();
  });

  it('flush is re-entrant — concurrent calls share the same drain', async () => {
    const runner = new Runner(outbox, { connectivity: conn, scheduler: sched });
    let resolveHandler!: () => void;
    const gate = new Promise<void>((res) => {
      resolveHandler = res;
    });
    const handlerCalls = vi.fn(() => gate);
    runner.register('k', handlerCalls);

    await outbox.enqueue('k', {});

    const a = runner.flush();
    const b = runner.flush();
    expect(a).toBe(b);

    resolveHandler();
    await a;
    expect(handlerCalls).toHaveBeenCalledTimes(1);
  });

  it('schedules a wake-up at the next pending scheduledAt after a failure', async () => {
    const runner = new Runner(outbox, {
      connectivity: conn,
      scheduler: sched,
      now,
    });
    const handler = vi
      .fn<(payload: unknown) => Promise<void>>()
      .mockRejectedValueOnce(new Error('x'))
      .mockResolvedValueOnce(undefined);
    runner.register('k', handler);

    await outbox.enqueue('k', {});
    await runner.start();
    expect(handler).toHaveBeenCalledTimes(1);

    expect(sched.pending()).toHaveLength(1);
    expect(sched.pending()[0].delay).toBe(1_000);

    clock.t += 1_000;
    sched.fireAll();
    await runner.flush();

    expect(handler).toHaveBeenCalledTimes(2);
    expect(await outbox.list()).toHaveLength(0);
    await runner.stop();
  });

  it('does not schedule a wake-up when the queue is empty', async () => {
    const runner = new Runner(outbox, { connectivity: conn, scheduler: sched });
    await runner.start();
    expect(sched.pending()).toHaveLength(0);
    await runner.stop();
  });

  it('start is idempotent', async () => {
    const runner = new Runner(outbox, { connectivity: conn, scheduler: sched });
    await runner.start();
    await runner.start();
    await runner.stop();
  });

  it('stop detaches connectivity listeners and cancels pending timers', async () => {
    const runner = new Runner(outbox, { connectivity: conn, scheduler: sched });
    const handler = vi.fn(async () => {
      throw new Error('x');
    });
    runner.register('k', handler);

    await outbox.enqueue('k', {});
    await runner.start();
    expect(sched.pending()).toHaveLength(1);

    await runner.stop();

    expect(sched.pending()).toHaveLength(0);

    conn.set(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('notify triggers a drain only when started', async () => {
    const runner = new Runner(outbox, { connectivity: conn, scheduler: sched });
    const handler = vi.fn(async () => {});
    runner.register('k', handler);

    await outbox.enqueue('k', {});

    runner.notify();
    await new Promise((r) => setTimeout(r, 0));
    expect(handler).not.toHaveBeenCalled();

    await runner.start();
    runner.notify();
    await runner.flush();
    expect(handler).toHaveBeenCalledTimes(1);
    await runner.stop();
  });

  it('unregister removes a handler', async () => {
    const runner = new Runner(outbox, { connectivity: conn, scheduler: sched });
    const handler = vi.fn(async () => {});
    runner.register('k', handler);
    runner.unregister('k');

    await outbox.enqueue('k', {});
    await runner.flush();

    expect(handler).not.toHaveBeenCalled();
    expect((await outbox.list({ status: 'pending' }))[0].lastError).toMatch(/no handler/i);
  });

  it('fires onChange after each op transitions', async () => {
    const onChange = vi.fn();
    const runner = new Runner(outbox, { connectivity: conn, scheduler: sched, onChange });
    runner.register('ok', async () => {});
    runner.register('bad', async () => {
      throw new Error('e');
    });

    await outbox.enqueue('ok', {});
    await outbox.enqueue('bad', {});
    await outbox.enqueue('mystery', {});

    await runner.flush();
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('browserConnectivity reflects navigator.onLine and dispatches online/offline events', () => {
    const listener = vi.fn();
    const unsub = browserConnectivity.subscribe(listener);
    expect(browserConnectivity.isOnline()).toBe(true);

    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
    expect(listener).toHaveBeenCalledWith(false);
    expect(listener).toHaveBeenCalledWith(true);

    unsub();
    listener.mockClear();
    window.dispatchEvent(new Event('online'));
    expect(listener).not.toHaveBeenCalled();
  });

  it('browserScheduler runs and cancels timers', async () => {
    const fn = vi.fn();
    const cancel = browserScheduler.schedule(fn, 0);
    await new Promise((r) => setTimeout(r, 5));
    expect(fn).toHaveBeenCalledTimes(1);

    const fn2 = vi.fn();
    const cancel2 = browserScheduler.schedule(fn2, 50);
    cancel2();
    await new Promise((r) => setTimeout(r, 60));
    expect(fn2).not.toHaveBeenCalled();

    cancel();
  });
});
