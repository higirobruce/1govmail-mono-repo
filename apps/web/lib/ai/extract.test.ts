import { describe, it, expect, vi, afterEach } from 'vitest';
import { htmlToText, stripQuotedReply, stripSignature, clampText, extractEmailText } from './extract';

// Fixtures are shaped like real RISA mail: a short new message sitting on top
// of a quoted chain, which is exactly the case where collapsing all whitespace
// and keeping the history hands the model the wrong conversation.

const GMAIL_REPLY = `Muraho Jean,

Confirmed — I will send the signed MoU before Friday 14:00. Two points:

- The annex still lists the old RISA address; I have corrected it.
- Budget line 4.2 needs the Ministry of Finance code before we submit.

Murakoze,
Aline

On Tue, 3 Mar 2026 at 09:14, Jean Uwase <jean.uwase@risa.gov.rw> wrote:
> Hi Aline,
>
> Could you confirm the MoU signature date? The Minister's office is asking
> for it before the Wednesday cabinet meeting.
>
> Regards,
> Jean`;

const GMAIL_REPLY_NEW_PART = `Muraho Jean,

Confirmed — I will send the signed MoU before Friday 14:00. Two points:

- The annex still lists the old RISA address; I have corrected it.
- Budget line 4.2 needs the Ministry of Finance code before we submit.

Murakoze,
Aline`;

const OUTLOOK_CHAIN = `Approved. Please proceed with option B and copy the procurement team on the award letter.

Regards,
Bruce Higiro
Director of Digital Services, RISA

-----Original Message-----
From: Procurement Unit <procurement@risa.gov.rw>
Sent: Monday, 2 March 2026 16:42
To: Bruce Higiro <bruce.higiro@risa.gov.rw>
Subject: RE: Data centre tender - option A vs B

We need a decision on the data centre tender before Wednesday. Option A is
cheaper; option B has the longer support window.`;

const OUTLOOK_DIVIDER = `Noted, I will join the 10:00 session and present the migration status.

________________________________
From: ICT Operations <ict@risa.gov.rw>
Sent: 02 March 2026 11:05
To: All Staff
Subject: Migration readiness review

All directorate leads must attend the readiness review on Thursday.`;

const FRENCH_REPLY = `Bonjour Jean,

Le rapport trimestriel est prêt. Je l'envoie au Ministère demain matin, avec
les annexes budgétaires signées.

Cordialement,
Aline

Le 3 mars 2026 à 09:14, Jean Uwase <jean.uwase@risa.gov.rw> a écrit :
Bonjour Aline, pouvez-vous confirmer la date de remise du rapport trimestriel ?`;

const SIGNED_MAIL = `Thanks for the update — I will review the draft data protection policy and
revert with comments by Thursday.

--
Aline Mukamana
Senior Legal Advisor | Rwanda Information Society Authority
+250 788 000 000 | aline.mukamana@risa.gov.rw
Kigali, Rwanda`;

const SIGNED_REPLY_WITH_QUOTE = `Approved. Please proceed with option B and copy the procurement team.

--
Bruce Higiro
Director of Digital Services, RISA
+250 788 111 222

-----Original Message-----
From: Procurement Unit <procurement@risa.gov.rw>
Sent: Monday, 2 March 2026 16:42
To: Bruce Higiro <bruce.higiro@risa.gov.rw>
Subject: RE: Data centre tender

We need a decision on the data centre tender before Wednesday.`;

const HTML_MAIL = `<div dir="ltr">
  <p>Dear colleagues,</p>
  <p>The system migration window is confirmed for <b>Saturday 7 March</b>, 22:00&ndash;04:00.
     During this window:</p>
  <ul>
    <li>Mail delivery will be queued, not lost.</li>
    <li>Webmail will be unavailable.</li>
    <li>Mobile sync will resume automatically.</li>
  </ul>
  <p>Please inform your teams.<br>Thank you,<br>ICT Operations</p>
  <style>.hdr{color:red}</style>
  <img src="https://tracker.example/open.gif" width="1" height="1">
</div>`;

describe('htmlToText', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps paragraphs on separate lines', () => {
    const lines = htmlToText(HTML_MAIL).split('\n');
    expect(lines[0]).toBe('Dear colleagues,');
    expect(lines).toContain(
      'The system migration window is confirmed for Saturday 7 March, 22:00–04:00. During this window:',
    );
  });

  it('renders list items as dashed lines', () => {
    const lines = htmlToText(HTML_MAIL).split('\n');
    expect(lines).toContain('- Mail delivery will be queued, not lost.');
    expect(lines).toContain('- Webmail will be unavailable.');
    expect(lines).toContain('- Mobile sync will resume automatically.');
  });

  it('turns <br> into newlines', () => {
    expect(htmlToText(HTML_MAIL)).toContain('Please inform your teams.\nThank you,\nICT Operations');
  });

  it('drops style content and image attributes', () => {
    const out = htmlToText(HTML_MAIL);
    expect(out).not.toContain('color:red');
    expect(out).not.toContain('tracker.example');
  });

  it('collapses runs of spaces without eating the paragraph break', () => {
    expect(htmlToText('<p>Hello    there</p><p>second</p>')).toBe('Hello there\n\nsecond');
  });

  it('keeps consecutive divs on their own lines rather than spacing them out', () => {
    expect(htmlToText('<div>line one</div><div>line two</div><div>line three</div>')).toBe(
      'line one\nline two\nline three',
    );
  });

  it('caps consecutive blank lines at one', () => {
    const out = htmlToText('<p>a</p><br><br><br><br><br><p>b</p>');
    expect(out).toBe('a\n\nb');
    expect(out).not.toMatch(/\n{3,}/);
  });

  it('separates table cells and rows', () => {
    const out = htmlToText('<table><tr><td>Kigali</td><td>142</td></tr><tr><td>Huye</td><td>37</td></tr></table>');
    expect(out).toBe('Kigali 142\nHuye 37');
  });

  // Mail HTML is untrusted. An inert DOMParser document fetches no remote
  // subresources and fires no handlers; innerHTML on a live element does both.
  // jsdom loads nothing either way, so this guards the implementation choice
  // rather than an observable difference.
  it('never builds nodes in the live document', () => {
    const createElement = vi.spyOn(document, 'createElement');
    const createRange = vi.spyOn(document, 'createRange');

    htmlToText('<img src="https://tracker.example/p.gif"><p>body</p>');

    expect(createElement).not.toHaveBeenCalled();
    expect(createRange).not.toHaveBeenCalled();
  });

  it('still produces structured text without a DOMParser (SSR)', () => {
    vi.stubGlobal('DOMParser', undefined);
    try {
      const out = htmlToText(HTML_MAIL);
      const lines = out.split('\n');
      expect(lines[0]).toBe('Dear colleagues,');
      expect(lines).toContain('- Webmail will be unavailable.');
      expect(out).not.toContain('<');
      expect(out).not.toContain('color:red');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('stripQuotedReply', () => {
  it('cuts a Gmail "On … wrote:" attribution and keeps the new message verbatim', () => {
    expect(stripQuotedReply(GMAIL_REPLY)).toBe(GMAIL_REPLY_NEW_PART);
  });

  it('cuts an Outlook -----Original Message----- chain', () => {
    const out = stripQuotedReply(OUTLOOK_CHAIN);
    expect(out).toBe(
      'Approved. Please proceed with option B and copy the procurement team on the award letter.\n\nRegards,\nBruce Higiro\nDirector of Digital Services, RISA',
    );
  });

  it('cuts at the Outlook divider rather than the later header block', () => {
    expect(stripQuotedReply(OUTLOOK_DIVIDER)).toBe(
      'Noted, I will join the 10:00 session and present the migration status.',
    );
  });

  it('cuts a bare From:/Sent:/To:/Subject: header block', () => {
    const out = stripQuotedReply(
      `Yes, the venue is booked for 40 people on Thursday.\n\nFrom: Events Team <events@risa.gov.rw>\nSent: 01 March 2026 08:00\nTo: Aline Mukamana\nSubject: Venue confirmation\n\nHow many seats do you need?`,
    );
    expect(out).toBe('Yes, the venue is booked for 40 people on Thursday.');
  });

  it('cuts a French "a écrit :" attribution without touching a leading "Le …" sentence', () => {
    expect(stripQuotedReply(FRENCH_REPLY)).toBe(
      "Bonjour Jean,\n\nLe rapport trimestriel est prêt. Je l'envoie au Ministère demain matin, avec\nles annexes budgétaires signées.\n\nCordialement,\nAline",
    );
  });

  it('cuts a Kinyarwanda "yanditse:" attribution', () => {
    const out = stripQuotedReply(
      `Yego, nzohereza raporo ejo mu gitondo mbere ya saa yine.\n\nKu wa 3 Werurwe 2026, Jean Uwase <jean.uwase@risa.gov.rw> yanditse:\nMuraho, raporo izaba yiteguye ryari?`,
    );
    expect(out).toBe('Yego, nzohereza raporo ejo mu gitondo mbere ya saa yine.');
  });

  it('cuts plain ">" quoting when there is no attribution line', () => {
    const out = stripQuotedReply(
      `Confirmed, the servers are racked and powered in the Kigali facility.\n\n> Are the servers racked yet? Procurement is asking for a photo.`,
    );
    expect(out).toBe('Confirmed, the servers are racked and powered in the Kigali facility.');
  });

  it('ignores prose that merely starts a line with "On" but still cuts the real attribution', () => {
    const prose = `On the other hand, option A costs less to operate over five years.\n\nI would still recommend option B for the support window.`;
    expect(stripQuotedReply(prose)).toBe(prose);
    expect(
      stripQuotedReply(
        `${prose}\n\nOn Tue, 3 Mar 2026 at 09:14, Jean Uwase <jean.uwase@risa.gov.rw> wrote:\n> Which option do you recommend?`,
      ),
    ).toBe(prose);
  });

  it('keeps the original when the cut would leave almost nothing', () => {
    const quote = `On Tue, 3 Mar 2026 at 09:14, Jean Uwase <jean.uwase@risa.gov.rw> wrote:\n> Please confirm you received the tender documents for the Kigali data centre.`;
    const tooShort = `Noted.\n\n${quote}`;
    expect(stripQuotedReply(tooShort)).toBe(tooShort);
    // …but the same shape does get cut once there is a message worth keeping.
    expect(stripQuotedReply(`Noted, I have countersigned the annex.\n\n${quote}`)).toBe(
      'Noted, I have countersigned the annex.',
    );
  });

  it('leaves an unquoted message untouched, markers-shaped prose included', () => {
    const plain =
      'The quarterly ICT report is attached.\n\nIt goes to: all directorate leads. No action is required this cycle.';
    expect(stripQuotedReply(plain)).toBe(plain);
    expect(stripQuotedReply(`${plain}\n\n> Has the quarterly report been circulated?`)).toBe(plain);
  });
});

describe('stripSignature', () => {
  it('cuts at the standalone "--" delimiter', () => {
    expect(stripSignature(SIGNED_MAIL)).toBe(
      'Thanks for the update — I will review the draft data protection policy and\nrevert with comments by Thursday.',
    );
  });

  it('cuts at "-- " with the RFC trailing space', () => {
    const out = stripSignature('Please find the signed annex attached for your records.\n\n-- \nBruce Higiro\nRISA');
    expect(out).toBe('Please find the signed annex attached for your records.');
  });

  it('cuts a mobile footer', () => {
    expect(
      stripSignature('Yes, please go ahead with the venue booking for 40 people.\n\nSent from my iPhone'),
    ).toBe('Yes, please go ahead with the venue booking for 40 people.');
    expect(stripSignature('Approved, proceed with the award letter today.\n\nSent from Mail for Windows')).toBe(
      'Approved, proceed with the award letter today.',
    );
  });

  it('cuts only the two-dash delimiter, not a "---" rule inside the body', () => {
    const rule = 'Budget approved.\n---\nNext steps follow in a separate mail from the procurement unit.';
    expect(stripSignature(rule)).toBe(rule);
    expect(stripSignature('Budget approved for the full amount.\n--\nAline Mukamana\nRISA')).toBe(
      'Budget approved for the full amount.',
    );
  });

  it('keeps the original when the signature is all there is', () => {
    const sigOnly = 'Ok.\n\n--\nAline Mukamana\nSenior Legal Advisor | RISA';
    expect(stripSignature(sigOnly)).toBe(sigOnly);
    expect(stripSignature('Ok, that works for me.\n\n--\nAline Mukamana\nSenior Legal Advisor | RISA')).toBe(
      'Ok, that works for me.',
    );
  });
});

describe('clampText', () => {
  it('truncates on a word boundary, never mid-word', () => {
    expect(clampText('The quick brown fox jumps over the lazy dog', 17)).toBe('The quick brown\n\n[…truncated]');
    // No boundary to use within the budget — a hard cut is the only option.
    expect(clampText('a'.repeat(50), 10)).toBe('aaaaaaaaaa\n\n[…truncated]');
  });

  it('does not leave a dangling space before the marker', () => {
    expect(clampText('The quick brown fox jumps over the lazy dog', 20)).toBe('The quick brown fox\n\n[…truncated]');
  });

  it('marks the text only when it actually truncated', () => {
    expect(clampText('exactly ten', 11)).toBe('exactly ten');
    expect(clampText('The quick brown fox', 100)).toBe('The quick brown fox');
    expect(clampText('The quick brown fox', 10)).toBe('The quick\n\n[…truncated]');
  });

  it('handles empty text and non-positive caps', () => {
    expect(clampText('', 100)).toBe('');
    expect(clampText('anything', 0)).toBe('');
  });
});

describe('extractEmailText', () => {
  it('prefers bodyText and never parses the HTML alternative', () => {
    const out = extractEmailText({
      bodyText: 'The plain text alternative wins.\n\nAnd its second paragraph survives.',
      bodyHtml: '<p>The HTML alternative</p>',
    });
    expect(out).toBe('The plain text alternative wins.\n\nAnd its second paragraph survives.');
  });

  it('falls back to bodyHtml when bodyText is blank, and to nothing when both are', () => {
    const lines = extractEmailText({ bodyText: '   \n  ', bodyHtml: HTML_MAIL }).split('\n');
    expect(lines[0]).toBe('Dear colleagues,');
    expect(lines).toContain('- Webmail will be unavailable.');

    expect(extractEmailText({})).toBe('');
    expect(extractEmailText({ bodyText: null, bodyHtml: null })).toBe('');
    expect(extractEmailText({ bodyText: '   ' })).toBe('');
  });

  it('strips quoted history and signature together', () => {
    expect(extractEmailText({ bodyText: SIGNED_REPLY_WITH_QUOTE })).toBe(
      'Approved. Please proceed with option B and copy the procurement team.',
    );
  });

  it('keeps quoted history when asked to', () => {
    const out = extractEmailText({ bodyText: GMAIL_REPLY }, { keepQuoted: true });
    expect(out).toContain('Aline\n\nOn Tue, 3 Mar 2026 at 09:14');
    expect(out).toContain("> Could you confirm the MoU signature date? The Minister's office is asking");
  });

  it('clamps to maxChars on a word boundary after stripping', () => {
    const out = extractEmailText({ bodyText: GMAIL_REPLY }, { maxChars: 40 });
    expect(out).toBe('Muraho Jean,\n\nConfirmed — I will send\n\n[…truncated]');
  });

  it('strips before clamping, so the budget is spent on the new message', () => {
    // The raw body is 471 chars, the new message alone 241. Clamping before
    // stripping would spend the budget on the quote and truncate mid-thought.
    const out = extractEmailText({ bodyText: GMAIL_REPLY }, { maxChars: 260 });
    expect(out).toBe(GMAIL_REPLY_NEW_PART);
  });

  it('normalizes CRLF bodies', () => {
    expect(extractEmailText({ bodyText: 'First line.\r\n\r\nSecond line.' })).toBe('First line.\n\nSecond line.');
  });

  it('does not throw on malformed HTML', () => {
    expect(() => extractEmailText({ bodyHtml: '<p>unclosed <div><span>nested' })).not.toThrow();
    expect(extractEmailText({ bodyHtml: '<p>unclosed <div><span>nested' })).toBe('unclosed\n\nnested');
  });
});
