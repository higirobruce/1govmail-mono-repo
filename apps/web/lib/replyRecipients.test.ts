import { describe, it, expect } from 'vitest';
import { computeReplyRecipients } from './replyRecipients';

const me = 'bruce.higiro@risa.gov.rw';
const msg = {
  fromEmail: 'alice@risa.gov.rw',
  fromName: 'Alice',
  toRecipients: [{ email: me, name: 'Bruce' }, { email: 'carol@risa.gov.rw', name: 'Carol' }],
  ccRecipients: [{ email: 'dan@risa.gov.rw', name: 'Dan' }, { email: me }],
};

describe('computeReplyRecipients', () => {
  it('reply → sender only', () => {
    expect(computeReplyRecipients(msg, 'reply', me)).toEqual({
      to: [{ email: 'alice@risa.gov.rw', name: 'Alice' }],
      cc: [],
    });
  });

  it('replyAll → sender + other To recipients, CC minus me, no duplicates', () => {
    const r = computeReplyRecipients(msg, 'replyAll', me);
    expect(r.to.map((x) => x.email)).toEqual(['alice@risa.gov.rw', 'carol@risa.gov.rw']);
    expect(r.cc.map((x) => x.email)).toEqual(['dan@risa.gov.rw']);
  });

  it('replying to my own message → original To recipients', () => {
    const own = { ...msg, fromEmail: me, fromName: 'Bruce' };
    const r = computeReplyRecipients(own, 'reply', me);
    expect(r.to.map((x) => x.email)).toEqual(['carol@risa.gov.rw']);
  });

  it('matches emails case-insensitively', () => {
    const r = computeReplyRecipients({ ...msg, fromEmail: 'ALICE@RISA.GOV.RW' }, 'replyAll', me.toUpperCase());
    expect(r.to.map((x) => x.email)).toEqual(['ALICE@RISA.GOV.RW', 'carol@risa.gov.rw']);
    expect(r.cc.map((x) => x.email)).toEqual(['dan@risa.gov.rw']);
  });
});
