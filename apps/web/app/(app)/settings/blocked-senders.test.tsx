import { describe, it, expect } from 'vitest';
import { isValidSenderAddress } from './blocked-senders-helpers';

describe('isValidSenderAddress', () => {
  it('accepts a plain email address', () => {
    expect(isValidSenderAddress('person@example.com')).toBe(true);
  });

  it('accepts a domain wildcard', () => {
    expect(isValidSenderAddress('@example.com')).toBe(true);
  });

  it('rejects empty or whitespace-only input', () => {
    expect(isValidSenderAddress('')).toBe(false);
    expect(isValidSenderAddress('   ')).toBe(false);
  });

  it('rejects input with no domain', () => {
    expect(isValidSenderAddress('notanaddress')).toBe(false);
  });
});
