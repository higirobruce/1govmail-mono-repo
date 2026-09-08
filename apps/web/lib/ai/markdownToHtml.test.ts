import { describe, it, expect } from 'vitest';
import { markdownToHtml } from './markdownToHtml';

describe('markdownToHtml', () => {
  it('renders paragraphs and line breaks', () => {
    expect(markdownToHtml('one\n\ntwo')).toBe('<p>one</p><p>two</p>');
    expect(markdownToHtml('a\nb')).toBe('<p>a<br>b</p>');
  });
  it('renders bold, italic and inline code', () => {
    expect(markdownToHtml('**b** and *i* and `c`')).toBe('<p><strong>b</strong> and <em>i</em> and <code>c</code></p>');
  });
  it('renders headings', () => {
    expect(markdownToHtml('## Title')).toBe('<h2>Title</h2>');
  });
  it('renders bullet and numbered lists', () => {
    expect(markdownToHtml('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(markdownToHtml('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>');
  });
  it('renders blockquotes and code fences (fence content escaped)', () => {
    expect(markdownToHtml('> hi')).toBe('<blockquote><p>hi</p></blockquote>');
    expect(markdownToHtml('```\n<b>x</b>\n```')).toBe('<pre><code>&lt;b&gt;x&lt;/b&gt;</code></pre>');
  });
  it('keeps raw HTML in the markdown escaped as text', () => {
    expect(markdownToHtml('<script>alert(1)</script>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(markdownToHtml('**<img src=x onerror=y>**')).toBe('<p><strong>&lt;img src=x onerror=y&gt;</strong></p>');
  });
  it('allows only http(s) links; hostile schemes render as plain text', () => {
    expect(markdownToHtml('[ok](https://risa.gov.rw)')).toBe('<p><a href="https://risa.gov.rw">ok</a></p>');
    expect(markdownToHtml('[bad](javascript:alert(1))')).toBe('<p>[bad](javascript:alert(1))</p>');
  });
  it('falls back to plain paragraphs for weird input', () => {
    expect(markdownToHtml('   ')).toBe('');
  });
});
