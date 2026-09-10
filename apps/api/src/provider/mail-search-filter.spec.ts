import { quoteZimbra, quoteAqs, isEmptyFilter } from './mail-search-filter';

describe('quoteZimbra', () => {
  it('wraps in quotes and neutralises injected operators', () => {
    expect(quoteZimbra('budget')).toBe('"budget"');
    // an attempt to break out / inject an operator stays inside the quoted literal
    expect(quoteZimbra('a" OR is:anywhere')).toBe('"a\\" OR is:anywhere"');
    expect(quoteZimbra('back\\slash')).toBe('"back\\\\slash"');
  });
});

describe('quoteAqs', () => {
  it('wraps in quotes and strips embedded quotes (AQS has no escape)', () => {
    expect(quoteAqs('budget')).toBe('"budget"');
    expect(quoteAqs('a" OR from:x')).toBe('"a OR from:x"');
  });
});

describe('isEmptyFilter', () => {
  it('is true only when every field is empty/absent', () => {
    expect(isEmptyFilter({})).toBe(true);
    expect(isEmptyFilter({ keyword: '', from: '  ' })).toBe(true);
    expect(isEmptyFilter({ hasAttachment: false, unread: undefined })).toBe(false);
    expect(isEmptyFilter({ subject: 'x' })).toBe(false);
    expect(isEmptyFilter({ hasAttachment: true })).toBe(false);
    expect(isEmptyFilter({ unread: false })).toBe(false);
  });
});
