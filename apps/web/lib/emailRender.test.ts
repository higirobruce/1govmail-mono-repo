import { describe, it, expect, vi } from 'vitest';
import { createEmailPreparer, prepareEmailHtml, extractBodyContent } from './emailRender';

describe('extractBodyContent', () => {
  it('returns the inner body of a full HTML document', () => {
    expect(extractBodyContent('<html><head><style>p{}</style></head><body class="x"><p>hi</p></body></html>'))
      .toBe('<p>hi</p>');
  });

  it('strips head/html/body wrappers when there is no well-formed body element', () => {
    expect(extractBodyContent('<head><title>t</title></head><p>hi</p>')).toBe('<p>hi</p>');
  });

  it('passes fragment HTML through unchanged', () => {
    expect(extractBodyContent('<p>hi</p>')).toBe('<p>hi</p>');
  });
});

describe('createEmailPreparer', () => {
  it('converts Zimbra dfsrc attributes to src', () => {
    const prepare = createEmailPreparer((h) => h);
    expect(prepare('<img dfsrc="https://x/y.png">')).toContain('src="https://x/y.png"');
  });

  it('strips the non-standard name= parameter from data URIs', () => {
    const prepare = createEmailPreparer((h) => h);
    expect(prepare('<img src="data:image/gif; name="foo.gif";base64,AAAA">'))
      .toContain('data:image/gif;base64,AAAA');
  });

  it('sanitizes and caches: repeated input runs the sanitizer once and returns the identical string', () => {
    const sanitize = vi.fn((h: string) => h.toUpperCase());
    const prepare = createEmailPreparer(sanitize);

    const first = prepare('<p>hi</p>');
    const second = prepare('<p>hi</p>');

    expect(sanitize).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('caches per input — different bodies do not collide', () => {
    const sanitize = vi.fn((h: string) => h);
    const prepare = createEmailPreparer(sanitize);

    expect(prepare('<p>a</p>')).toContain('a');
    expect(prepare('<p>b</p>')).toContain('b');
    expect(sanitize).toHaveBeenCalledTimes(2);
  });

  it('evicts old entries past the cap instead of growing unbounded', () => {
    const sanitize = vi.fn((h: string) => h);
    const prepare = createEmailPreparer(sanitize);

    for (let i = 0; i < 25; i++) prepare(`<p>${i}</p>`);
    sanitize.mockClear();
    prepare('<p>0</p>'); // long evicted — must re-run the sanitizer
    expect(sanitize).toHaveBeenCalledTimes(1);
  });
});

describe('prepareEmailHtml (default sanitizer)', () => {
  it('strips script tags and event handlers via sanitizeEmailHtml', () => {
    const out = prepareEmailHtml('<p onclick="x()">hi</p><script>evil()</script>');
    expect(out).not.toContain('script');
    expect(out).not.toContain('onclick');
    expect(out).toContain('hi');
  });
});
