import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OfflineDB } from './db';
import { Outbox } from './outbox';

function fixedClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

function counterId(prefix = 'op') {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

describe('Outbox', () => {
  let db: OfflineDB;

  beforeEach(async () => {
    db = new OfflineDB(`outbox-${crypto.randomUUID()}`);
    await db.open();
  });

  afterEach(async () => {
    db.close();
  });

  it('enqueues an op with sensible defaults', async () => {
    const clock = fixedClock();
    const ob = new Outbox(db, { now: clock.now, randomId: counterId() });

    const id = await ob.enqueue('mail.send', { to: 'a@b.c' });
    const op = await ob.get(id);

    expect(op).toBeDefined();
    expect(op!).toMatchObject({
      id: 'op-1',
      kind: 'mail.send',
      payload: { to: 'a@b.c' },
      status: 'pending',
      attempts: 0,
      maxAttempts: 5,
      createdAt: 1_000_000,
      scheduledAt: 1_000_000,
    });
    expect(op!.idempotencyKey).toBeUndefined();
    expect(op!.lastError).toBeUndefined();
  });

  it('peekReady returns pending ops scheduled at-or-before now, FIFO by scheduledAt', async () => {
    const clock = fixedClock(0);
    const ob = new Outbox(db, { now: clock.now, randomId: counterId() });

    clock.set(100);
    await ob.enqueue('a', {});
    clock.set(50);
    await ob.enqueue('b', {});
    clock.set(300);
    await ob.enqueue('c', {});

    clock.set(200);
    const ready = await ob.peekReady();
    expect(ready.map((o) => o.kind)).toEqual(['b', 'a']);
  });

  it('peekReady excludes running and failed ops', async () => {
    const clock = fixedClock();
    const ob = new Outbox(db, { now: clock.now, randomId: counterId(), random: () => 0 });

    const a = await ob.enqueue('a', {}, { maxAttempts: 1 });
    const b = await ob.enqueue('b', {});
    const c = await ob.enqueue('c', {});

    await ob.markRunning(b);
    await ob.markFailed(a, new Error('boom'));

    const ready = await ob.peekReady();
    expect(ready.map((o) => o.id)).toEqual([c]);
  });

  it('peekReady honours the limit', async () => {
    const clock = fixedClock();
    const ob = new Outbox(db, { now: clock.now, randomId: counterId() });
    for (let i = 0; i < 5; i++) await ob.enqueue('k', { i });

    const ready = await ob.peekReady(2);
    expect(ready).toHaveLength(2);
  });

  it('markDone removes the row', async () => {
    const ob = new Outbox(db, { randomId: counterId() });
    const id = await ob.enqueue('a', {});
    await ob.markDone(id);
    expect(await ob.get(id)).toBeUndefined();
  });

  it('markFailed reschedules with exponential backoff (jitter pinned)', async () => {
    const clock = fixedClock(10_000);
    const ob = new Outbox(db, {
      now: clock.now,
      randomId: counterId(),
      random: () => 0,
    });

    const id = await ob.enqueue('a', {});

    await ob.markFailed(id, new Error('e1'));
    let op = await ob.get(id);
    expect(op).toMatchObject({ status: 'pending', attempts: 1, lastError: 'e1' });
    expect(op!.scheduledAt).toBe(10_000 + 1_000);

    await ob.markFailed(id, 'string error');
    op = await ob.get(id);
    expect(op).toMatchObject({ attempts: 2, lastError: 'string error' });
    expect(op!.scheduledAt).toBe(10_000 + 2_000);

    await ob.markFailed(id, new Error('e3'));
    op = await ob.get(id);
    expect(op!.scheduledAt).toBe(10_000 + 4_000);

    await ob.markFailed(id, new Error('e4'));
    op = await ob.get(id);
    expect(op!.scheduledAt).toBe(10_000 + 8_000);
  });

  it('markFailed adds jitter from the injected random source', async () => {
    const clock = fixedClock(0);
    const ob = new Outbox(db, {
      now: clock.now,
      randomId: counterId(),
      random: () => 0.5,
    });

    const id = await ob.enqueue('a', {});
    await ob.markFailed(id, new Error('x'));
    const op = await ob.get(id);
    expect(op!.scheduledAt).toBe(1_000 + 500);
  });

  it('markFailed terminals the op once attempts hit maxAttempts', async () => {
    const ob = new Outbox(db, { randomId: counterId(), random: () => 0 });
    const id = await ob.enqueue('a', {}, { maxAttempts: 2 });

    await ob.markFailed(id, new Error('first'));
    expect((await ob.get(id))!.status).toBe('pending');

    await ob.markFailed(id, new Error('final'));
    const op = await ob.get(id);
    expect(op).toMatchObject({
      status: 'failed',
      attempts: 2,
      lastError: 'final',
    });

    const ready = await ob.peekReady();
    expect(ready).toHaveLength(0);
  });

  it('markFailed is a no-op for an unknown id', async () => {
    const ob = new Outbox(db);
    await expect(ob.markFailed('nope', new Error('x'))).resolves.toBeUndefined();
  });

  it('markFailed caps backoff at MAX_BACKOFF_MS', async () => {
    const clock = fixedClock(0);
    const ob = new Outbox(db, { now: clock.now, randomId: counterId(), random: () => 0 });
    const id = await ob.enqueue('a', {}, { maxAttempts: 100 });

    for (let i = 0; i < 20; i++) {
      await ob.markFailed(id, new Error('x'));
      clock.set(0);
    }
    const op = await ob.get(id);
    expect(op!.scheduledAt).toBeLessThanOrEqual(5 * 60 * 1_000);
    expect(op!.scheduledAt).toBe(5 * 60 * 1_000);
  });

  it('enqueue with idempotencyKey returns existing id when a non-terminal op exists', async () => {
    const ob = new Outbox(db, { randomId: counterId() });

    const first = await ob.enqueue('a', { v: 1 }, { idempotencyKey: 'k' });
    const second = await ob.enqueue('a', { v: 2 }, { idempotencyKey: 'k' });
    expect(second).toBe(first);

    const all = await ob.list();
    expect(all).toHaveLength(1);
    expect(all[0].payload).toEqual({ v: 1 });
  });

  it('enqueue with idempotencyKey allows a new op once the prior one is failed', async () => {
    const ob = new Outbox(db, { randomId: counterId(), random: () => 0 });
    const first = await ob.enqueue('a', {}, { idempotencyKey: 'k', maxAttempts: 1 });
    await ob.markFailed(first, new Error('x'));

    const second = await ob.enqueue('a', {}, { idempotencyKey: 'k' });
    expect(second).not.toBe(first);
    expect(await ob.list({ status: 'pending' })).toHaveLength(1);
    expect(await ob.list({ status: 'failed' })).toHaveLength(1);
  });

  it('list filters by status and kind', async () => {
    const ob = new Outbox(db, { randomId: counterId(), random: () => 0 });
    const a = await ob.enqueue('mail.send', {}, { maxAttempts: 1 });
    await ob.enqueue('mail.send', {});
    await ob.enqueue('mail.archive', {});
    await ob.markFailed(a, new Error('x'));

    expect(await ob.list({ status: 'failed' })).toHaveLength(1);
    expect(await ob.list({ kind: 'mail.send' })).toHaveLength(2);
    expect(await ob.list({ status: 'pending', kind: 'mail.archive' })).toHaveLength(1);
    expect(await ob.list()).toHaveLength(3);
  });

  it('nextScheduledAt returns the earliest pending scheduledAt', async () => {
    const clock = fixedClock(0);
    const ob = new Outbox(db, { now: clock.now, randomId: counterId() });

    expect(await ob.nextScheduledAt()).toBeUndefined();

    clock.set(500);
    await ob.enqueue('a', {});
    clock.set(100);
    const second = await ob.enqueue('b', {});
    clock.set(900);
    await ob.enqueue('c', {});

    expect(await ob.nextScheduledAt()).toBe(100);

    await ob.markRunning(second);
    expect(await ob.nextScheduledAt()).toBe(500);
  });

  it('recoverRunning flips orphaned running rows back to pending', async () => {
    const ob = new Outbox(db, { randomId: counterId() });
    const a = await ob.enqueue('a', {});
    const b = await ob.enqueue('b', {});
    const c = await ob.enqueue('c', {});

    await ob.markRunning(a);
    await ob.markRunning(b);

    const recovered = await ob.recoverRunning();
    expect(recovered).toBe(2);

    expect((await ob.get(a))!.status).toBe('pending');
    expect((await ob.get(b))!.status).toBe('pending');
    expect((await ob.get(c))!.status).toBe('pending');
    expect(await ob.recoverRunning()).toBe(0);
  });

  it('clear empties the outbox', async () => {
    const ob = new Outbox(db, { randomId: counterId() });
    await ob.enqueue('a', {});
    await ob.enqueue('b', {});
    await ob.clear();
    expect(await ob.list()).toEqual([]);
  });
});
