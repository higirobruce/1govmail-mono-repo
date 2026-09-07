import { mdToHtml } from '@email-client/shared';

describe('mdToHtml', () => {
  it('renders paragraphs and line breaks', () => {
    expect(mdToHtml('one\n\ntwo')).toBe('<p>one</p><p>two</p>');
    expect(mdToHtml('a\nb')).toBe('<p>a<br>b</p>');
  });

  it('renders bold, italic and inline code', () => {
    expect(mdToHtml('**b** and *i* and `c`')).toBe(
      '<p><strong>b</strong> and <em>i</em> and <code>c</code></p>',
    );
  });

  it('renders headings and lists', () => {
    expect(mdToHtml('## Title')).toBe('<h2>Title</h2>');
    expect(mdToHtml('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(mdToHtml('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>');
  });

  it('renders blockquotes and code fences (fence content escaped)', () => {
    expect(mdToHtml('> hi')).toBe('<blockquote><p>hi</p></blockquote>');
    expect(mdToHtml('```\n<b>x</b>\n```')).toBe('<pre><code>&lt;b&gt;x&lt;/b&gt;</code></pre>');
  });

  it('keeps raw HTML in the markdown escaped as text', () => {
    expect(mdToHtml('<script>alert(1)</script>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(mdToHtml('**<img src=x onerror=y>**')).toBe('<p><strong>&lt;img src=x onerror=y&gt;</strong></p>');
  });

  it('allows only http(s) links; hostile schemes render as plain text', () => {
    expect(mdToHtml('[ok](https://risa.gov.rw)')).toBe('<p><a href="https://risa.gov.rw">ok</a></p>');
    expect(mdToHtml('[bad](javascript:alert(1))')).toBe('<p>[bad](javascript:alert(1))</p>');
  });

  it('returns empty string for blank input', () => {
    expect(mdToHtml('   ')).toBe('');
  });
});
