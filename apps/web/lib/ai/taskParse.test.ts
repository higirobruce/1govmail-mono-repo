import { describe, it, expect, vi } from 'vitest';
import { parseTaskInput, fallbackParse } from './taskParse';

const NOW = new Date('2026-09-05T10:00:00Z'); // a Saturday

describe('parseTaskInput', () => {
  it('returns the model-parsed fields', async () => {
    const chat = vi.fn(async (_opts: any) => JSON.stringify({ title: 'Chase the TOR', dueDate: '2026-09-11', priority: 'HIGH' }));
    const r = await parseTaskInput({ chat }, 'chase the TOR from Solange on Friday, urgent-ish', { model: 'm', now: NOW });
    expect(r).toEqual({ title: 'Chase the TOR', dueDate: '2026-09-11', priority: 'HIGH' });
  });

  it('passes the reference date and fenced input to the model', async () => {
    const chat = vi.fn(async (_opts: any) => JSON.stringify({ title: 't', dueDate: null, priority: null }));
    await parseTaskInput({ chat }, 'remind me Friday', { model: 'm', now: NOW });
    const req = chat.mock.calls[0][0];
    expect(req.model).toBe('m');
    expect(req.responseFormat).toBe('json');
    const sys = req.messages.find((m: any) => m.role === 'system').content;
    expect(sys).toContain('2026-09-05');
    const user = req.messages.find((m: any) => m.role === 'user').content;
    expect(user).toContain('remind me Friday');
  });

  it('salvages JSON wrapped in prose', async () => {
    const chat = vi.fn(async (_opts: any) => 'Sure! {"title":"t","dueDate":null,"priority":null} hope that helps');
    const r = await parseTaskInput({ chat }, 'x', { model: 'm', now: NOW });
    expect(r.title).toBe('t');
  });

  it('normalizes junk fields (bad date, unknown priority) to null', async () => {
    const chat = vi.fn(async (_opts: any) => JSON.stringify({ title: 't', dueDate: 'whenever', priority: 'MEGA' }));
    const r = await parseTaskInput({ chat }, 'x', { model: 'm', now: NOW });
    expect(r).toEqual({ title: 't', dueDate: null, priority: null });
  });

  it('falls back to the raw input on error or garbage', async () => {
    const chat = vi.fn(async (_opts: any) => { throw new Error('boom'); });
    const r = await parseTaskInput({ chat }, '  buy stamps  ', { model: 'm', now: NOW });
    expect(r).toEqual({ title: 'buy stamps', dueDate: null, priority: null });
  });
});

describe('fallbackParse', () => {
  it('trims and nulls the rest', () => {
    expect(fallbackParse(' x ')).toEqual({ title: 'x', dueDate: null, priority: null });
  });
});
