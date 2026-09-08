import { describe, it, expect } from 'vitest';
import { buildEmailFrameCss } from './emailFrameCss';

// In dark mode the reader iframes used to keep a hardcoded #ffffff canvas —
// the one surface that ignored the app theme. The builder must swap the whole
// palette, not just the background, so links/quotes/code stay readable.
describe('buildEmailFrameCss', () => {
  it('keeps the classic white canvas in light mode', () => {
    const css = buildEmailFrameCss({ dark: false, normalize: false });
    expect(css).toContain('background:#ffffff');
    expect(css).toContain('color-scheme:light');
    // Raw mode: sender styles must win, so no !important overrides.
    expect(css).not.toContain('!important');
  });

  it('paints the dark frame with the app card color, never white', () => {
    const css = buildEmailFrameCss({ dark: true, normalize: false });
    expect(css).not.toMatch(/#fff\b|#ffffff/i);
    expect(css).toContain('oklch(0.16 0.018 255)'); // --card in .dark
    expect(css).toContain('color-scheme:dark');
  });

  it('adds !important normalize overrides in both themes', () => {
    for (const dark of [false, true]) {
      const css = buildEmailFrameCss({ dark, normalize: true });
      expect(css).toContain('background-color:transparent!important');
      expect(css).toContain('text-transform:none!important');
    }
  });

  it('dark normalized forces the dark canvas and light text over inline styles', () => {
    const css = buildEmailFrameCss({ dark: true, normalize: true });
    expect(css).toContain('background-color:oklch(0.16 0.018 255)!important');
    expect(css).toContain('color:oklch(0.95 0.006 245)!important');
    expect(css).not.toMatch(/#fff\b|#ffffff/i);
  });
});
