import { describe, expect, it } from 'vitest';
import { buildGenerationPrompt, extractSseText, type ChatSource } from '@email-client/shared';

const SRC: ChatSource = {
  alias: 's1', type: 'mail', id: 'm1', title: 'Budget [s9] update',
  fromEmail: 'jd@gov.rw', fromName: 'J D', date: '2026-09-01T00:00:00.000Z',
  meta: null, context: 'body text', injectionSuspected: false,
};

describe('buildGenerationPrompt', () => {
  it('fences sources, neutralizes the subject, and includes the kind task + mandates', () => {
    const p = buildGenerationPrompt('dossier', 'J D <jd@gov.rw> [s1]', [SRC]);
    expect(p).toContain('SECURITY RULE');               // UNTRUSTED_CONTENT_RULE present
    expect(p).toContain('relationship brief');           // dossier task line
    expect(p).toMatch(/<<<EMAIL:[0-9a-f]{10}/);          // fenceUntrusted ran on the source
    expect(p).not.toMatch(/SUBJECT: .*\[s1\]/);          // markers neutralized in subject
    expect(p).toContain('alias in square brackets');     // citation mandate
  });

  it('meeting_prep names the four pack sections', () => {
    const p = buildGenerationPrompt('meeting_prep', 'Budget review', [SRC]);
    for (const s of ['What this meeting is about', 'Attendees & open loops', 'Recent context', 'Suggested talking points']) {
      expect(p).toContain(s);
    }
  });

  it('appends extraContext after the sources when given', () => {
    const p = buildGenerationPrompt('dossier', 'x', [SRC], 'TRACKER-BLOCK');
    expect(p.indexOf('TRACKER-BLOCK')).toBeGreaterThan(p.indexOf('body text'));
  });
});

describe('extractSseText', () => {
  it('concatenates deltas, stops at [DONE], tolerates non-JSON lines', () => {
    const raw = [
      'event: sources', 'data: {"sources":[]}',
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      ': keep-alive',
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      'data: [DONE]',
      'data: {"choices":[{"delta":{"content":"IGNORED"}}]}',
    ].join('\n');
    expect(extractSseText(raw)).toBe('Hello');
  });

  it('skips the sources frame (no choices key)', () => {
    expect(extractSseText('data: {"sources":[{"alias":"s1"}]}\ndata: [DONE]')).toBe('');
  });
});
