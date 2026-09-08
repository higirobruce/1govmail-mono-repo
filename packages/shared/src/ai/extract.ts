/**
 * Turning a raw email body into the few thousand characters a 2B local model
 * can actually reason about. Two things matter: keeping the line structure
 * (paragraphs and bullet lists carry meaning) and dropping quoted history, so
 * the budget is spent on the NEW message rather than on the thread it replies to.
 */

// Block boundaries are emitted as sentinels rather than newlines so a run of
// them can afterwards be collapsed by strength: a paragraph earns a blank line,
// a tight block only a line break. Mail HTML nests these deeply (a <ul> inside
// a <div> inside a <table>), so without that pass every bullet would be spaced.
const PARA_BREAK = '\u0002';
const TIGHT_BREAK = '\u0001';
const BREAK_RUN = /[ \t]*[\u0001\u0002][ \t\u0001\u0002]*/g;

const PARA_TAGS = new Set([
  'P',
  'BLOCKQUOTE',
  'PRE',
  'UL',
  'OL',
  'DL',
  'TABLE',
  'SECTION',
  'ARTICLE',
  'HEADER',
  'FOOTER',
  'ASIDE',
  'MAIN',
  'NAV',
  'FIELDSET',
  'FORM',
  'ADDRESS',
  'FIGURE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
]);

const TIGHT_TAGS = new Set([
  'DIV',
  'LI',
  'DT',
  'DD',
  'THEAD',
  'TBODY',
  'TFOOT',
  'TR',
  'CAPTION',
  'FIGCAPTION',
]);

const DROPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'HEAD', 'TITLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT']);

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const hex = name[1] === 'x' || name[1] === 'X';
      const code = hex ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/**
 * Collapse horizontal whitespace only. Single newlines survive — they are the
 * paragraph and bullet structure we went to the trouble of reconstructing —
 * while runs of three or more flatten to a single blank line.
 */
function normalizeLines(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200B\uFEFF]/g, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Resolve runs of break sentinels into real newlines. */
function resolveBreaks(text: string): string {
  return normalizeLines(text.replace(BREAK_RUN, (run) => (run.includes(PARA_BREAK) ? '\n\n' : '\n')));
}

/** SSR / no-DOM path: a tag strip that still marks block boundaries. */
function htmlToTextFallback(html: string): string {
  const paras = [...PARA_TAGS].map((t) => t.toLowerCase()).join('|');
  const tights = [...TIGHT_TAGS].map((t) => t.toLowerCase()).join('|');
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|title|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\b[^>]*>/gi, TIGHT_BREAK)
    .replace(/<hr\b[^>]*>/gi, PARA_BREAK)
    .replace(/<li\b[^>]*>/gi, `${TIGHT_BREAK}- `)
    .replace(new RegExp(`</?(?:${paras})\\b[^>]*>`, 'gi'), PARA_BREAK)
    .replace(new RegExp(`</?(?:${tights})\\b[^>]*>`, 'gi'), TIGHT_BREAK)
    .replace(/<\/?(?:td|th)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '');

  // Newlines in the source are formatting, not structure, so flatten them first
  // and let the sentinels supply the real line breaks.
  return resolveBreaks(decodeEntities(stripped).replace(/\s+/g, ' '));
}

/**
 * HTML → plain text, preserving block structure. Parsed with DOMParser, which
 * yields an inert document: no remote subresources are fetched (tracking
 * pixels) and no handlers fire, unlike innerHTML on a live element. Mail HTML
 * is untrusted, so that property is load-bearing.
 */
export function htmlToText(html: string): string {
  if (!html) return '';
  if (typeof document === 'undefined' || typeof DOMParser === 'undefined') return htmlToTextFallback(html);

  let body: HTMLElement | null;
  try {
    body = new DOMParser().parseFromString(html, 'text/html').body;
  } catch {
    return htmlToTextFallback(html);
  }
  if (!body) return htmlToTextFallback(html);

  const out: string[] = [];

  const walk = (node: Node, inPre: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const raw = node.nodeValue ?? '';
      out.push(inPre ? raw : raw.replace(/\s+/g, ' '));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (DROPPED_TAGS.has(tag)) return;
    if (tag === 'BR') {
      out.push(TIGHT_BREAK);
      return;
    }
    if (tag === 'HR') {
      out.push(PARA_BREAK);
      return;
    }

    const brk = PARA_TAGS.has(tag) ? PARA_BREAK : TIGHT_TAGS.has(tag) ? TIGHT_BREAK : '';
    if (brk) out.push(brk);
    if (tag === 'LI') out.push('- ');

    const pre = inPre || tag === 'PRE';
    for (let child = el.firstChild; child; child = child.nextSibling) walk(child, pre);

    if (tag === 'TD' || tag === 'TH') out.push(' ');
    if (brk) out.push(brk);
  };

  for (let child = body.firstChild; child; child = child.nextSibling) walk(child, false);

  return resolveBreaks(out.join(''));
}

// Anything at or after one of these markers is history, not the new message.
// Only the earliest match is cut, so a phrase appearing further down cannot
// widen the cut.
const QUOTE_MARKERS: RegExp[] = [
  // A quoted line: "> ..." (plain-text replies, any nesting depth).
  /^[ \t]{0,3}>/m,
  // Gmail/Apple Mail attribution, which often wraps over two or three lines. A
  // date must appear near the start, else ordinary prose like "On the other
  // hand…" would match and swallow the whole message.
  /^[ \t]*On\s+[^\n]{0,80}?\d[\s\S]{0,300}?\bwrote\s*:[ \t]*$/m,
  // French: "Le mar. 3 mars 2026 à 09:14, Jean Uwase a écrit :"
  /^[ \t]*Le\s+(?:\S+\s+){0,2}\d{1,4}\b[\s\S]{0,300}?\ba\s+écrit\s*:/m,
  // Kinyarwanda: "Ku wa 3 Werurwe 2026, Jean Uwase yanditse:"
  /^[^\n]{0,200}\byanditse\s*:[ \t]*$/m,
  /^[ \t]*-{2,}[ \t]*Original Message[ \t]*-{2,}/im,
  /^[ \t]*-{2,}[ \t]*Message d'origine[ \t]*-{2,}/im,
  /^[ \t]*-{2,}[ \t]*Forwarded message[ \t]*-{2,}/im,
  // Outlook's horizontal rule between the reply and the quoted mail.
  /^[ \t]*_{10,}[ \t]*$/m,
  // Outlook header block: "From: …" followed by Sent/Date/To/Subject.
  /^[ \t]*From[ \t]*:[ \t]*\S[^\n]*\n(?:[^\n]*\n){0,3}?[ \t]*(?:Sent|Date|To|Cc|Subject)[ \t]*:/im,
  /^[ \t]*De[ \t]*:[ \t]*\S[^\n]*\n(?:[^\n]*\n){0,3}?[ \t]*(?:Envoyé|Date|À|Objet)[ \t]*:/im,
];

const SIGNATURE_MARKERS: RegExp[] = [
  // The RFC 3676 delimiter, with or without its trailing space.
  /^-{2}[ \t]*$/m,
  /^[ \t]*Sent from my (?:iPhone|iPad|Android|Samsung|BlackBerry|mobile)[^\n]*$/im,
  /^[ \t]*Sent from Mail for Windows[^\n]*$/im,
  /^[ \t]*Get Outlook for (?:iOS|Android)[^\n]*$/im,
  /^[ \t]*Envoyé de mon (?:iPhone|iPad)[^\n]*$/im,
];

/** Below this, a "successful" strip has eaten the message — keep the original instead. */
const MIN_KEPT_CHARS = 20;

function cutAtFirstMarker(text: string, markers: RegExp[]): string {
  let cut = -1;
  for (const marker of markers) {
    const match = marker.exec(text);
    if (match && (cut === -1 || match.index < cut)) cut = match.index;
  }
  if (cut === -1) return text;

  const kept = text.slice(0, cut).trim();
  return kept.length >= MIN_KEPT_CHARS ? kept : text;
}

/**
 * Drop quoted history: ">" quoting, Gmail/Apple attribution lines, Outlook
 * dividers and header blocks. Returns the input untouched if the cut would
 * leave nothing worth reading — a summary of stale text beats no summary.
 */
export function stripQuotedReply(text: string): string {
  if (!text) return '';
  return cutAtFirstMarker(text, QUOTE_MARKERS);
}

/** Drop a trailing signature block, under the same non-empty safety rule. */
export function stripSignature(text: string): string {
  if (!text) return '';
  return cutAtFirstMarker(text, SIGNATURE_MARKERS);
}

/** Trim to a character cap on a word boundary. ~3000 chars ≈ 700–900 tokens. */
export function clampText(text: string, maxChars: number): string {
  if (!text) return '';
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;

  const window = text.slice(0, maxChars);
  const boundary = Math.max(window.lastIndexOf(' '), window.lastIndexOf('\n'), window.lastIndexOf('\t'));
  // Honour the boundary only when it is not so far back that most of the budget
  // is wasted; a single 3000-character "word" still has to be cut somewhere.
  const kept = boundary > maxChars / 2 ? window.slice(0, boundary) : window;

  return kept.trimEnd() + '\n\n[…truncated]';
}

export interface ExtractOptions {
  /** Character budget handed to the model. Default 3000. */
  maxChars?: number;
  /** Keep quoted history and signatures, e.g. when the whole chain is the subject. */
  keepQuoted?: boolean;
}

/**
 * The entry point callers should use: pick the cheapest usable body, drop the
 * noise, clamp to the model's budget. Never throws — bad input yields ''.
 */
export function extractEmailText(
  input: { bodyText?: string | null; bodyHtml?: string | null },
  opts: ExtractOptions = {},
): string {
  const maxChars = opts.maxChars ?? 3000;
  try {
    if (!input) return '';
    const plain = input.bodyText?.trim()
      ? normalizeLines(input.bodyText)
      : input.bodyHtml
        ? htmlToText(input.bodyHtml)
        : '';
    if (!plain) return '';

    const body = opts.keepQuoted ? plain : stripSignature(stripQuotedReply(plain));
    return clampText(body.trim(), maxChars);
  } catch {
    return '';
  }
}
