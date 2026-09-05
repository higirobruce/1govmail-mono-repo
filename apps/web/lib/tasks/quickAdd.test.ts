import { describe, it, expect, vi } from 'vitest';
import { quickAddTask } from './quickAdd';

describe('quickAddTask', () => {
  it('AI off: creates from raw title only and never calls the model', async () => {
    const chat = vi.fn(async () => 'unused');
    const create = vi.fn(async (p: any) => ({ id: 't1', ...p }));

    const { task, parsed } = await quickAddTask('raw text', {
      enabled: false,
      model: 'm',
      client: { chat },
      create,
    });

    expect(chat).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith({ title: 'raw text' });
    expect(parsed).toEqual({ title: 'raw text', dueDate: null, priority: null });
    expect(task).toEqual({ id: 't1', title: 'raw text' });
  });

  it('AI on: forwards the parsed dueDate and priority to create', async () => {
    const chat = vi.fn(async () =>
      JSON.stringify({ title: 'Chase the TOR', dueDate: '2026-09-11', priority: 'HIGH' }),
    );
    const create = vi.fn(async (p: any) => ({ id: 't2', ...p }));

    const { task, parsed } = await quickAddTask('chase the TOR from Solange on Friday', {
      enabled: true,
      model: 'gemma2:2b',
      client: { chat },
      create,
    });

    expect(chat).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      title: 'Chase the TOR',
      dueDate: '2026-09-11',
      priority: 'HIGH',
    });
    expect(parsed).toEqual({ title: 'Chase the TOR', dueDate: '2026-09-11', priority: 'HIGH' });
    expect(task.id).toBe('t2');
  });

  it('AI on but nothing extracted: create receives only the title', async () => {
    const chat = vi.fn(async () => JSON.stringify({ title: 'buy stamps', dueDate: null, priority: null }));
    const create = vi.fn(async (p: any) => ({ id: 't3', ...p }));

    await quickAddTask('buy stamps', {
      enabled: true,
      model: 'm',
      client: { chat },
      create,
    });

    expect(create).toHaveBeenCalledWith({ title: 'buy stamps' });
  });
});
