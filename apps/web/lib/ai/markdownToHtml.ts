import DOMPurify from 'isomorphic-dompurify';
import { mdToHtml } from '@email-client/shared';

/**
 * Escape-first Markdown subset → sanitized HTML, for AI output rendered into
 * the docs editor. The conversion itself lives in @email-client/shared
 * (mdToHtml): model output can never open a tag — every character is
 * HTML-escaped BEFORE the whitelisted markdown constructs are re-introduced.
 * DOMPurify runs over the result here as a second lock for DOM sinks.
 * Supported: paragraphs/<br/>, #–### headings, **bold**, *italic*, `code`,
 * ``` fences, - / 1. lists (flat), > quotes, http(s) links.
 */

const ALLOWED_TAGS = ['p', 'br', 'strong', 'em', 'code', 'pre', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'blockquote', 'a'];

export function markdownToHtml(md: string): string {
  return DOMPurify.sanitize(mdToHtml(md), {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ['href'],
    ALLOWED_URI_REGEXP: /^https?:\/\//i,
  });
}
