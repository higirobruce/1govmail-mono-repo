import { describe, it, expect, vi } from 'vitest';
import { downloadAll } from './downloadAll';

const atts = [
  { messageId: 'm1', id: 'a1', filename: 'one.pdf' },
  { messageId: 'm1', id: 'a2', filename: 'two.png' },
  { messageId: 'm2', id: 'a3', filename: 'three.zip' },
];

describe('downloadAll', () => {
  it('downloads every attachment sequentially and returns the count', async () => {
    const order: string[] = [];
    const getUrl = vi.fn(async (_mid: string, aid: string) => { order.push(aid); return `blob:${aid}`; });
    const clicks: string[] = [];
    const spy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this.download);
    });
    const n = await downloadAll(atts, getUrl, { delayMs: 0 });
    expect(n).toBe(3);
    expect(order).toEqual(['a1', 'a2', 'a3']);
    expect(clicks).toEqual(['one.pdf', 'two.png', 'three.zip']);
    spy.mockRestore();
  });

  it('skips failures, reports them, and keeps going', async () => {
    const getUrl = vi.fn(async (_mid: string, aid: string) => {
      if (aid === 'a2') throw new Error('boom');
      return `blob:${aid}`;
    });
    const spy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const failed: string[] = [];
    const n = await downloadAll(atts, getUrl, { delayMs: 0, onError: (f) => failed.push(f) });
    expect(n).toBe(2);
    expect(failed).toEqual(['two.png']);
    spy.mockRestore();
  });
});
