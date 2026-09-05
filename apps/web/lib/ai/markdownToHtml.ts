import DOMPurify from 'isomorphic-dompurify';

/**
 * Escape-first Markdown subset → sanitized HTML, for AI output rendered into
 * the docs editor. Security posture matches textToHtml: model output can
 * never open a tag — every character is HTML-escaped BEFORE the whitelisted
 * markdown constructs are re-introduced, and DOMPurify runs over the result
 * as a second lock. Supported: paragraphs/<br/>, #–### headings, **bold**,
 * *italic*, `code`, ``` fences, - / 1. lists (flat), > quotes, http(s) links.
 */

const ALLOWED_TAGS = ['p', 'br', 'strong', 'em', 'code', 'pre', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'blockquote', 'a'];

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Inline constructs on already-escaped text. */
function inline(escaped: string): string {
  let s = escaped;
  // `code` first so its contents are exempt from bold/italic processing
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  // links: [text](https://…) only — anything else stays literal text
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2">$1</a>');
  return s;
}

export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').trim().split('\n');
  const out: string[] = [];
  let para: string[] = [];
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null;
  let fence: string[] | null = null;

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.map((l) => inline(escapeHtml(l))).join('<br>')}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`);
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');

    if (fence) {
      if (/^```/.test(line)) {
        out.push(`<pre><code>${fence.map(escapeHtml).join('\n')}</code></pre>`);
        fence = null;
      } else {
        fence.push(line);
      }
      continue;
    }
    if (/^```/.test(line)) { flushPara(); flushList(); fence = []; continue; }

    if (!line.trim()) { flushPara(); flushList(); continue; }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flushPara(); flushList();
      out.push(`<h${heading[1].length}>${inline(escapeHtml(heading[2]))}</h${heading[1].length}>`);
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || ordered) {
      flushPara();
      const tag = bullet ? 'ul' : 'ol';
      const item = inline(escapeHtml((bullet ?? ordered)![1]));
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push(item);
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushPara(); flushList();
      out.push(`<blockquote><p>${inline(escapeHtml(quote[1]))}</p></blockquote>`);
      continue;
    }

    flushList();
    para.push(line);
  }
  if (fence) out.push(`<pre><code>${fence.map(escapeHtml).join('\n')}</code></pre>`);
  flushPara(); flushList();

  return DOMPurify.sanitize(out.join(''), {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ['href'],
    ALLOWED_URI_REGEXP: /^https?:\/\//i,
  });
}
