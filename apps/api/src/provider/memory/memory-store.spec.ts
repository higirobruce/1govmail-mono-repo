import { MemoryStore } from './memory-store';

const NOW = 1757500000000; // fixed instant
const now = () => NOW;

describe('MemoryStore.seedFor', () => {
  it('returns the SAME mailbox object on repeat calls for the same email (identity)', () => {
    const store = new MemoryStore(now);
    const first = store.seedFor('demo@memory.local', 'pw1');
    const second = store.seedFor('demo@memory.local', 'pw2');
    expect(second).toBe(first);
  });

  it('a second call with a different password updates the stored password', () => {
    const store = new MemoryStore(now);
    const first = store.seedFor('demo@memory.local', 'pw1');
    expect(first.password).toBe('pw1');
    const second = store.seedFor('demo@memory.local', 'pw2');
    expect(second.password).toBe('pw2');
    // and the identity's own password field reflects the update too
    expect(first.password).toBe('pw2');
  });
});
