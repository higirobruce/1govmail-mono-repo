import { describe, it, expect } from 'vitest';
import { FONT_SIZE_MAP } from './theme.store';

describe('FONT_SIZE_MAP', () => {
  it('defaults to the web-standard 16px base', () => {
    expect(FONT_SIZE_MAP.default).toBe('16px');
  });

  it('keeps an even scale around the default', () => {
    expect(FONT_SIZE_MAP.sm).toBe('14px');
    expect(FONT_SIZE_MAP.lg).toBe('18px');
    expect(FONT_SIZE_MAP.xl).toBe('20px');
  });
});
