import { describe, it, expect } from 'vitest';
import { parseMailDragPayload, dropPrefillFromPayload } from './dropPrefill';
import type { MailDragPayload } from './dropPrefill';

describe('parseMailDragPayload', () => {
  it('parses a valid JSON payload', () => {
    const raw = JSON.stringify({
      id: 'm1',
      subject: 'Budget review',
      snippet: 'Let’s meet to review the budget.',
      from: 'Alice Doe <alice@example.com>',
    });
    const result = parseMailDragPayload(raw);
    expect(result).toEqual({
      id: 'm1',
      subject: 'Budget review',
      snippet: 'Let’s meet to review the budget.',
      from: 'Alice Doe <alice@example.com>',
    });
  });

  it('returns null for garbage (non-JSON) input', () => {
    expect(parseMailDragPayload('not json{{{')).toBeNull();
  });

  it('returns null when id is missing', () => {
    const raw = JSON.stringify({ subject: 'x', snippet: 'y', from: 'z' });
    expect(parseMailDragPayload(raw)).toBeNull();
  });

  it('returns null when id is not a string', () => {
    const raw = JSON.stringify({ id: 42, subject: 'x', snippet: 'y', from: 'z' });
    expect(parseMailDragPayload(raw)).toBeNull();
  });

  it('returns null for a JSON array', () => {
    expect(parseMailDragPayload('[1,2,3]')).toBeNull();
  });

  it('returns null for JSON null', () => {
    expect(parseMailDragPayload('null')).toBeNull();
  });

  it('tolerates missing subject/snippet/from by defaulting to empty strings', () => {
    const raw = JSON.stringify({ id: 'm2' });
    const result = parseMailDragPayload(raw);
    expect(result).toEqual({ id: 'm2', subject: '', snippet: '', from: '' });
  });
});

describe('dropPrefillFromPayload', () => {
  it('maps subject to title', () => {
    const payload: MailDragPayload = {
      id: 'm1', subject: 'Budget review', snippet: 'Please review', from: 'Alice <a@example.com>',
    };
    const result = dropPrefillFromPayload(payload);
    expect(result.title).toBe('Budget review');
  });

  it('builds description as From: {from}\\n\\n{snippet}', () => {
    const payload: MailDragPayload = {
      id: 'm1', subject: 'Budget review', snippet: 'Please review', from: 'Alice <a@example.com>',
    };
    const result = dropPrefillFromPayload(payload);
    expect(result.description).toBe('From: Alice <a@example.com>\n\nPlease review');
  });

  it('sets linkedMessageId and aiFillMessageId to the payload id', () => {
    const payload: MailDragPayload = {
      id: 'm1', subject: 'Budget review', snippet: 'Please review', from: 'Alice <a@example.com>',
    };
    const result = dropPrefillFromPayload(payload);
    expect(result.linkedMessageId).toBe('m1');
    expect(result.aiFillMessageId).toBe('m1');
  });

  it('sets linkedSubject to the payload subject', () => {
    const payload: MailDragPayload = {
      id: 'm1', subject: 'Budget review', snippet: 'Please review', from: 'Alice <a@example.com>',
    };
    const result = dropPrefillFromPayload(payload);
    expect(result.linkedSubject).toBe('Budget review');
  });
});
