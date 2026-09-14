import { describe, it, expect, afterEach, vi } from 'vitest';
import { uuid } from './uuid';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuid', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses crypto.randomUUID when available (secure context)', () => {
    const spy = vi.fn(() => '11111111-1111-4111-8111-111111111111');
    vi.stubGlobal('crypto', { randomUUID: spy });
    expect(uuid()).toBe('11111111-1111-4111-8111-111111111111');
    expect(spy).toHaveBeenCalledOnce();
  });

  it('falls back to a valid v4 when crypto.randomUUID is missing (plain HTTP)', () => {
    vi.stubGlobal('crypto', {}); // no randomUUID — mimics a non-secure context
    const id = uuid();
    expect(id).toMatch(V4);
  });

  it('falls back when crypto itself is undefined', () => {
    vi.stubGlobal('crypto', undefined);
    expect(uuid()).toMatch(V4);
  });

  it('produces distinct ids on the fallback path', () => {
    vi.stubGlobal('crypto', {});
    expect(uuid()).not.toBe(uuid());
  });
});
