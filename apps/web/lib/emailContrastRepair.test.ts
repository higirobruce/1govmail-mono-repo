import { describe, it, expect } from 'vitest';
import {
  parseCssColor,
  contrastRatio,
  pickReadableColor,
  repairEmailContrast,
  MIN_CONTRAST,
} from './emailContrastRepair';

// With "Consistent email display" OFF the frame keeps the sender's own styling
// on a dark canvas. A sender who sets `color:#333` and no background — which is
// most government mail, authored against Outlook's white page — then renders
// dark-on-dark and is simply unreadable. The mirror case is just as real: a
// sender sets a white table background and our light body text inherits into
// it, giving light-on-light.

const DARK_BG = 'rgb(20, 24, 31)';
const LIGHT_TEXT = 'rgb(242, 244, 247)';

describe('parseCssColor', () => {
  it('reads the rgb form getComputedStyle returns', () => {
    expect(parseCssColor('rgb(51, 51, 51)')).toEqual({ r: 51, g: 51, b: 51, a: 1 });
  });

  it('reads rgba and keeps the alpha', () => {
    expect(parseCssColor('rgba(255, 255, 255, 0.5)')).toEqual({ r: 255, g: 255, b: 255, a: 0.5 });
  });

  it('treats the fully transparent black jsdom and browsers report as transparent', () => {
    expect(parseCssColor('rgba(0, 0, 0, 0)')?.a).toBe(0);
  });

  it('reads 6- and 3-digit hex, which inline styles still carry', () => {
    expect(parseCssColor('#333333')).toEqual({ r: 51, g: 51, b: 51, a: 1 });
    expect(parseCssColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });

  it('returns null for keywords it cannot resolve rather than guessing', () => {
    expect(parseCssColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseCssColor('inherit')).toBeNull();
    expect(parseCssColor('')).toBeNull();
  });
});

describe('contrastRatio', () => {
  it('gives 21:1 for black on white', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
  });

  it('gives 1:1 for a colour against itself', () => {
    expect(contrastRatio('#333333', '#333333')).toBeCloseTo(1, 5);
  });

  it('is order-independent', () => {
    expect(contrastRatio('#333', '#fff')).toBeCloseTo(contrastRatio('#fff', '#333'), 5);
  });

  it('rates the dark-on-dark case as failing', () => {
    expect(contrastRatio('rgb(51,51,51)', DARK_BG)).toBeLessThan(MIN_CONTRAST);
  });
});

describe('pickReadableColor', () => {
  it('returns the light token when the background is dark', () => {
    expect(pickReadableColor(DARK_BG, LIGHT_TEXT)).toBe(LIGHT_TEXT);
  });

  it('returns a near-black when the sender forced a light background', () => {
    // The mirror bug: our light body text inheriting into a white table.
    expect(pickReadableColor('rgb(255,255,255)', LIGHT_TEXT)).not.toBe(LIGHT_TEXT);
    expect(contrastRatio(pickReadableColor('rgb(255,255,255)', LIGHT_TEXT), '#ffffff'))
      .toBeGreaterThan(MIN_CONTRAST);
  });
});

/** Builds a document body and runs the repair over it. */
function repair(html: string) {
  document.body.innerHTML = html;
  document.body.style.backgroundColor = DARK_BG;
  document.body.style.color = LIGHT_TEXT;
  const repaired = repairEmailContrast(document, { text: LIGHT_TEXT, bg: DARK_BG });
  return repaired;
}

describe('repairEmailContrast', () => {
  it('rewrites text the sender hardcoded dark, on the dark canvas', () => {
    repair('<p id="t" style="color: rgb(51,51,51)">Ministerial directive</p>');

    const el = document.getElementById('t')!;
    expect(contrastRatio(el.style.color, DARK_BG)).toBeGreaterThan(MIN_CONTRAST);
  });

  it('leaves text that already reads well alone', () => {
    repair('<p id="t" style="color: rgb(200,210,220)">Already legible</p>');

    expect(document.getElementById('t')!.style.color).toBe('rgb(200, 210, 220)');
  });

  it('fixes light text that inherits into a sender-supplied white block', () => {
    // No color of its own — it inherits our light body text, over white.
    repair('<table id="t" style="background-color: rgb(255,255,255)"><tr><td id="c">Figures</td></tr></table>');

    const cell = document.getElementById('c')!;
    expect(contrastRatio(cell.style.color, 'rgb(255,255,255)')).toBeGreaterThan(MIN_CONTRAST);
  });

  it('resolves the background from an ancestor, not just the element itself', () => {
    repair(
      '<div style="background-color: rgb(255,255,255)">' +
      '<div><span id="t">nested</span></div></div>',
    );

    const el = document.getElementById('t')!;
    expect(contrastRatio(el.style.color, 'rgb(255,255,255)')).toBeGreaterThan(MIN_CONTRAST);
  });

  it('reports how many elements it rewrote', () => {
    const n = repair(
      '<p id="a" style="color: rgb(51,51,51)">one</p>' +
      '<p id="b" style="color: rgb(34,34,34)">two</p>' +
      '<p id="c" style="color: rgb(220,225,230)">fine</p>',
    );

    expect(n).toBe(2);
  });

  it('skips elements holding no text of their own', () => {
    // A wrapper div's color is irrelevant — only text nodes are visible, and
    // rewriting empty containers wastes the budget on a large newsletter.
    const n = repair('<div id="t" style="color: rgb(51,51,51)"><img src="x.png"></div>');

    expect(n).toBe(0);
  });

  it('stops at the element budget instead of janking a huge newsletter', () => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      `<p style="color: rgb(51,51,51)">row ${i}</p>`).join('');
    document.body.innerHTML = rows;
    document.body.style.backgroundColor = DARK_BG;
    document.body.style.color = LIGHT_TEXT;

    const n = repairEmailContrast(document, { text: LIGHT_TEXT, bg: DARK_BG, budget: 10 });

    expect(n).toBeLessThanOrEqual(10);
  });

  it('does nothing to a document with no body', () => {
    const empty = document.implementation.createHTMLDocument('');
    empty.documentElement.innerHTML = '';

    expect(() => repairEmailContrast(empty, { text: LIGHT_TEXT, bg: DARK_BG })).not.toThrow();
  });

  it('ignores a semi-transparent background rather than mis-measuring it', () => {
    // Compositing a translucent layer is guesswork; the honest move is to fall
    // through to the nearest opaque ancestor, which here is the dark canvas.
    repair('<div style="background-color: rgba(255,255,255,0.4)"><p id="t" style="color: rgb(51,51,51)">x</p></div>');

    const el = document.getElementById('t')!;
    expect(contrastRatio(el.style.color, DARK_BG)).toBeGreaterThan(MIN_CONTRAST);
  });
});
