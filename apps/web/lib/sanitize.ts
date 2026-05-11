import DOMPurify from 'isomorphic-dompurify';

const EMAIL_ALLOWED_TAGS = [
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'cite', 'code', 'col', 'colgroup',
  'dd', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'font', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 'q', 'section', 'small', 'span',
  'strong', 'style', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr',
  'u', 'ul',
];

const EMAIL_ALLOWED_ATTR = [
  'href', 'title', 'target', 'rel', 'src', 'alt', 'width', 'height', 'align',
  'valign', 'colspan', 'rowspan', 'bgcolor', 'color', 'border', 'cellpadding',
  'cellspacing', 'style', 'class', 'id', 'dir',
];

// The email body is rendered inside a sandboxed iframe with scripts disabled,
// but sanitization is still required: the iframe still shares the same origin
// cache and DOMPurify strips event handlers, javascript: URIs, and other
// stored-XSS vectors before the HTML ever gets parsed.
export function sanitizeEmailHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: EMAIL_ALLOWED_TAGS,
    ALLOWED_ATTR: EMAIL_ALLOWED_ATTR,
    // Permit cid: and data: image URIs — mailers rely on them for inline images.
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|cid|data|blob):|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i,
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'link', 'meta', 'base'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur', 'onsubmit', 'onchange', 'formaction', 'srcdoc'],
    ALLOW_DATA_ATTR: false,
    KEEP_CONTENT: true,
  });
}

// Signatures are more restricted than email bodies because they are authored
// by the user inside TipTap — images, links, and basic formatting are enough.
const SIGNATURE_ALLOWED_TAGS = [
  'a', 'b', 'br', 'div', 'em', 'font', 'hr', 'i', 'img', 'li', 'ol', 'p', 'span',
  'strong', 'u', 'ul', 'table', 'tbody', 'tr', 'td',
];

const SIGNATURE_ALLOWED_ATTR = [
  'href', 'target', 'rel', 'src', 'alt', 'width', 'height', 'style', 'data-zimbra-src',
];

export function sanitizeSignatureHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: SIGNATURE_ALLOWED_TAGS,
    ALLOWED_ATTR: SIGNATURE_ALLOWED_ATTR,
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|cid|data):|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i,
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'link', 'meta', 'style'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur', 'srcdoc'],
    KEEP_CONTENT: true,
  });
}
