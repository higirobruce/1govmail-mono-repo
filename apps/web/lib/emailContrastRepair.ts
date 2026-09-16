/**
 * Contrast repair for raw (non-normalized) email bodies in dark mode.
 *
 * With "Consistent email display" ON, normalizeCss overrides sender colours
 * wholesale and none of this is needed. With it OFF the sender's own styling
 * wins on a dark canvas — and most government mail is authored against
 * Outlook's white page, so `color:#333` with no background renders dark text on
 * a dark card and is simply unreadable. The mirror case is equally real: a
 * sender supplies a white table background and our light body text inherits
 * into it, giving light-on-light.
 *
 * So rather than restyling the message, this measures each element's text
 * against the background it actually sits on and rewrites only what fails.
 *
 * Known limit: `background-image` and gradient backdrops cannot be measured, so
 * text over them keeps whatever the sender chose. Same for a translucent
 * background, where compositing the real colour is guesswork — that falls
 * through to the nearest opaque ancestor instead of being mis-measured.
 */

/** Below this ratio, text is rewritten. Deliberately under the WCAG AA 4.5
 *  threshold: the goal is rescuing unreadable mail, not restyling every email
 *  whose greys are merely a little soft. */
export const MIN_CONTRAST = 3.5;

/** Elements inspected before giving up. A 5,000-row HTML newsletter would
 *  otherwise pay a full style resolution per element on the main thread. */
const DEFAULT_BUDGET = 4000;

/** Text colour used when a failing element sits on a light background. Not
 *  pure black — that reads harsher than the surrounding mail. */
const DARK_INK = 'rgb(17, 17, 17)';

interface Rgba { r: number; g: number; b: number; a: number }

/** Parses the colour forms that reach us: the `rgb()`/`rgba()` that
 *  getComputedStyle normalizes to, plus the hex an inline style can carry.
 *  Returns null for anything unresolvable — callers then leave the element
 *  alone rather than acting on a guess. */
export function parseCssColor(value: string | null | undefined): Rgba | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };

  const fn = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/);
  if (fn) {
    return {
      r: Number(fn[1]),
      g: Number(fn[2]),
      b: Number(fn[3]),
      a: fn[4] === undefined ? 1 : Number(fn[4]),
    };
  }

  const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (hex) {
    const h = hex[1];
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
      a: 1,
    };
  }

  return null;
}

/** WCAG relative luminance. */
function luminance({ r, g, b }: Rgba): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two colours, 1:1 to 21:1. Returns 21 when
 *  either colour is unparseable, so unknown pairs are never "fixed". */
export function contrastRatio(a: string, b: string): number {
  const ca = parseCssColor(a);
  const cb = parseCssColor(b);
  if (!ca || !cb) return 21;
  const la = luminance(ca);
  const lb = luminance(cb);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** The readable ink for `background`: the frame's own light text on a dark
 *  backdrop, near-black on a light one. */
export function pickReadableColor(background: string, lightText: string): string {
  return contrastRatio(lightText, background) >= contrastRatio(DARK_INK, background)
    ? lightText
    : DARK_INK;
}

/**
 * First opaque background colour at or above `el`, falling back to the canvas.
 * Translucent layers are skipped rather than composited — see the file note.
 *
 * Memoized through `cache`. Walking to the root per element is O(elements x
 * depth), and email HTML nests tables 20+ deep — on a large newsletter that is
 * tens of thousands of blocking style resolutions. Callers walk in document
 * order (parents first), so each ancestor's answer is already cached and this
 * collapses to one resolution per element.
 */
function effectiveBackground(
  el: Element,
  canvasBg: string,
  win: Window,
  cache: Map<Element, string>,
): string {
  const hit = cache.get(el);
  if (hit !== undefined) return hit;

  const own = parseCssColor(win.getComputedStyle(el).backgroundColor);
  const resolved = own && own.a === 1
    ? `rgb(${own.r}, ${own.g}, ${own.b})`
    : el.parentElement
      ? effectiveBackground(el.parentElement, canvasBg, win, cache)
      : canvasBg;

  cache.set(el, resolved);
  return resolved;
}

/** True when the element renders text of its own. A wrapper div's colour is
 *  invisible, and rewriting empty containers wastes the budget. */
function hasOwnText(el: Element): boolean {
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3 /* text */ && (node.textContent ?? '').trim() !== '') return true;
  }
  return false;
}

/**
 * Rewrites the inline `color` of every text-bearing element whose contrast
 * against its real background falls below MIN_CONTRAST.
 *
 * @returns how many elements were rewritten.
 */
export function repairEmailContrast(
  doc: Document,
  opts: { text: string; bg: string; minRatio?: number; budget?: number },
): number {
  const body = doc.body;
  const win = doc.defaultView;
  if (!body || !win) return 0;

  const minRatio = opts.minRatio ?? MIN_CONTRAST;
  const budget = opts.budget ?? DEFAULT_BUDGET;

  let inspected = 0;
  let repaired = 0;
  // Document-order walk means an element's ancestors are always resolved
  // before it, so this stays one style resolution per element.
  const bgCache = new Map<Element, string>();

  const walker = doc.createTreeWalker(body, 1 /* NodeFilter.SHOW_ELEMENT */);
  let el = walker.nextNode() as Element | null;
  while (el) {
    if (++inspected > budget) break;

    if (hasOwnText(el)) {
      const color = win.getComputedStyle(el).color;
      const background = effectiveBackground(el, opts.bg, win, bgCache);
      if (contrastRatio(color, background) < minRatio) {
        (el as HTMLElement).style.setProperty(
          'color',
          pickReadableColor(background, opts.text),
          'important',
        );
        repaired++;
      }
    }

    el = walker.nextNode() as Element | null;
  }

  return repaired;
}
