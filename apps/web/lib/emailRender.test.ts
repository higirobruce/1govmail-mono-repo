import { describe, it, expect, vi } from 'vitest';
import { createEmailPreparer, prepareEmailHtml, extractBodyContent, rewriteCidRefs } from './emailRender';

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

describe('rewriteCidRefs', () => {
  const map = new Map([['c1', 'blob:x/1'], ['c2', 'blob:x/2']]);

  it('swaps a cid reference for its resolved url', () => {
    expect(rewriteCidRefs('<img src="cid:c1">', map)).toBe('<img src="blob:x/1">');
  });

  it('handles single quotes and mixed case', () => {
    expect(rewriteCidRefs("<img src='CID:c1'>", map)).toBe("<img src='blob:x/1'>");
  });

  it('swaps every occurrence, not just the first', () => {
    const out = rewriteCidRefs('<img src="cid:c1"><img src="cid:c2"><img src="cid:c1">', map);
    expect(out).toBe('<img src="blob:x/1"><img src="blob:x/2"><img src="blob:x/1">');
  });

  it('tolerates angle brackets around the cid, which is how they are stored', () => {
    expect(rewriteCidRefs('<img src="cid:<c1>">', map)).toBe('<img src="blob:x/1">');
  });

  it('leaves an unresolved cid alone rather than blanking the image', () => {
    const out = rewriteCidRefs('<img src="cid:unknown">', map);
    expect(out).toBe('<img src="cid:unknown">');
  });

  it('leaves html with no cid refs untouched', () => {
    expect(rewriteCidRefs('<p>hello</p>', map)).toBe('<p>hello</p>');
  });

  // The three normalisations below are not hypothetical — each is handled by the
  // embed code this replaces (mail.service.ts:1349-1358). Dropping any of them
  // means images silently failing to resolve on real mail while CI stays green.

  it('matches when the STORED cid is bracket-wrapped and the html is not', () => {
    const stored = new Map([['<img0@govmail>', 'blob:x/9']]);
    expect(rewriteCidRefs('<img src="cid:img0@govmail">', stored)).toBe('<img src="blob:x/9">');
  });

  it('matches when the html encodes the @ as an entity', () => {
    const stored = new Map([['img0@govmail', 'blob:x/9']]);
    expect(rewriteCidRefs('<img src="cid:img0&#64;govmail">', stored)).toBe('<img src="blob:x/9">');
    expect(rewriteCidRefs('<img src="cid:img0&#x40;govmail">', stored)).toBe('<img src="blob:x/9">');
  });

  it('falls back to the base when the html omits the @domain', () => {
    const stored = new Map([['image001.gif@01DD2986.DAAA8E30', 'blob:x/9']]);
    expect(rewriteCidRefs('<img src="cid:image001.gif">', stored)).toBe('<img src="blob:x/9">');
  });

  it('matches case-insensitively on the cid itself', () => {
    const stored = new Map([['IMG0@GovMail', 'blob:x/9']]);
    expect(rewriteCidRefs('<img src="cid:img0@govmail">', stored)).toBe('<img src="blob:x/9">');
  });

  it('returns the input unchanged for an empty map', () => {
    expect(rewriteCidRefs('<img src="cid:c1">', new Map())).toBe('<img src="cid:c1">');
  });
});
