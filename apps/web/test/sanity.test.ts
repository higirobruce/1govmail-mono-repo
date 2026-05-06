import { describe, it, expect } from 'vitest';

describe('test infra sanity', () => {
  it('runs vitest', () => {
    expect(1 + 1).toBe(2);
  });

  it('has jsdom globals', () => {
    expect(typeof window).toBe('object');
    expect(typeof document).toBe('object');
  });

  it('has fake-indexeddb wired', () => {
    expect(typeof indexedDB).toBe('object');
    expect(typeof indexedDB.open).toBe('function');
  });
});
