import { describe, it, expect, vi, afterEach } from 'vitest';
import { htmlToPlainText, truncate } from './tasks';

describe('htmlToPlainText', () => {
  afterEach(() => vi.restoreAllMocks());

  it('extracts text and collapses whitespace', () => {
    expect(htmlToPlainText('<p>Hello   <b>world</b></p>\n<p>again</p>')).toBe('Hello world again');
  });

  it('leaves plain text untouched', () => {
    expect(htmlToPlainText('just a plain body')).toBe('just a plain body');
  });

  it('drops markup rather than emitting it', () => {
    expect(htmlToPlainText('<img src="x" onerror="boom()">hi')).toBe('hi');
  });

  // Email bodies reaching this function are unsanitized remote HTML. Parsing
  // them into the *live* document (innerHTML on a created element) fetches
  // remote subresources and fires handlers in a real browser; an inert
  // DOMParser document does neither. jsdom loads no resources, so that
  // difference is not observable behaviourally — this guards the
  // implementation choice instead.
  it('never builds nodes in the live document', () => {
    const createElement = vi.spyOn(document, 'createElement');
    const createRange = vi.spyOn(document, 'createRange');

    htmlToPlainText('<img src="http://tracker.example/p.gif"><p>body</p>');

    expect(createElement).not.toHaveBeenCalled();
    expect(createRange).not.toHaveBeenCalled();
  });
});

describe('truncate', () => {
  it('leaves short text alone', () => {
    expect(truncate('short', 100)).toBe('short');
  });

  it('marks truncated text', () => {
    const out = truncate('a'.repeat(50), 10);
    expect(out.startsWith('a'.repeat(10))).toBe(true);
    expect(out).toContain('[…truncated]');
  });
});
