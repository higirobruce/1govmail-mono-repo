import { describe, it, expect } from 'vitest';
import { sourceHref } from './sourceNav';

describe('sourceHref', () => {
  it('maps a mail source to /mail?open=<id>', () => {
    expect(sourceHref({ type: 'mail', id: 'msg-1' })).toBe('/mail?open=msg-1');
  });

  it('maps a doc source to /docs?open=<id>', () => {
    expect(sourceHref({ type: 'doc', id: 'doc-1' })).toBe('/docs?open=doc-1');
  });

  it('maps an event source to /calendar?event=<id>', () => {
    expect(sourceHref({ type: 'event', id: 'evt-1' })).toBe('/calendar?event=evt-1');
  });

  it('URL-encodes ids with special characters', () => {
    expect(sourceHref({ type: 'mail', id: 'a b/c?d' })).toBe('/mail?open=a%20b%2Fc%3Fd');
    expect(sourceHref({ type: 'doc', id: 'x&y=z' })).toBe('/docs?open=x%26y%3Dz');
    expect(sourceHref({ type: 'event', id: 'e#1' })).toBe('/calendar?event=e%231');
  });
});
