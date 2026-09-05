import { describe, it, expect } from 'vitest';
import { textToHtml } from './textToHtml';

describe('textToHtml', () => {
  it('splits double newlines into paragraphs', () => {
    expect(textToHtml('one\n\ntwo')).toBe('<p>one</p><p>two</p>');
  });
  it('maps single newlines to <br/>', () => {
    expect(textToHtml('a\nb')).toBe('<p>a<br/>b</p>');
  });
  it('escapes angle brackets so model output cannot inject HTML', () => {
    expect(textToHtml('<script>x</script>')).toBe('<p>&lt;script>x&lt;/script></p>');
  });
  it('trims and collapses 3+ newlines like a double', () => {
    expect(textToHtml('\na\n\n\n\nb\n')).toBe('<p>a</p><p>b</p>');
  });
});
