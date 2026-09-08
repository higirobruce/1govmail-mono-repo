import { describe, it, expect } from 'vitest';
import { cn } from './utils';

describe('cn named text steps', () => {
  it('later named step overrides a stock size', () => {
    expect(cn('text-xs', 'text-micro')).toBe('text-micro');
    expect(cn('text-sm', 'text-ui')).toBe('text-ui');
  });
  it('named steps do not clobber text colors', () => {
    expect(cn('text-secondary-foreground', 'text-micro')).toBe('text-secondary-foreground text-micro');
  });
});
