import { describe, it, expect, vi } from 'vitest';
import { parseEventFromEmail, parseEventInput } from './eventParse';
import type { AIClient } from './client';

const NOW = new Date('2026-09-05T08:00:00'); // a Saturday, local

function mockClient(response: string): Pick<AIClient, 'chat'> {
  return { chat: vi.fn(async () => response) };
}

function rejectingClient(): Pick<AIClient, 'chat'> {
  return { chat: vi.fn(async () => { throw new Error('network down'); }) };
}

describe('parseEventInput', () => {
  it('parses a full result and normalizes attendees', async () => {
    const client = mockClient(
      '{"title":"Steering committee","startAt":"2026-09-08T10:00","endAt":"2026-09-08T11:00","allDay":false,"location":"Boardroom","attendees":["Erick@risa.gov.rw","erick@risa.gov.rw","tricia@risa.gov.rw"]}',
    );
    const r = await parseEventInput(client, 'Steering committee Tuesday 10-11', { model: 'm', now: NOW });
    expect(r.title).toBe('Steering committee');
    expect(r.startAt).toBe('2026-09-08T10:00');
    expect(r.endAt).toBe('2026-09-08T11:00');
    expect(r.allDay).toBe(false);
    expect(r.location).toBe('Boardroom');
    expect(r.attendees).toEqual(['erick@risa.gov.rw', 'tricia@risa.gov.rw']);
  });

  it('corrects endAt <= startAt to start + 1h', async () => {
    const client = mockClient(
      '{"title":"Sync","startAt":"2026-09-08T10:00","endAt":"2026-09-08T09:30","allDay":false,"location":null,"attendees":[]}',
    );
    const r = await parseEventInput(client, 'sync', { model: 'm', now: NOW });
    expect(r.startAt).toBe('2026-09-08T10:00');
    expect(r.endAt).toBe('2026-09-08T11:00');
  });

  it('normalizes a bare-date endAt against a timed startAt to start + 1h', async () => {
    const client = mockClient(
      '{"title":"Workshop","startAt":"2026-09-08T10:00","endAt":"2026-09-08","allDay":false,"location":null,"attendees":[]}',
    );
    const r = await parseEventInput(client, 'workshop', { model: 'm', now: NOW });
    expect(r.startAt).toBe('2026-09-08T10:00');
    expect(r.endAt).toBe('2026-09-08T11:00');
  });

  it('date with no time defaults to 09:00-10:00', async () => {
    const client = mockClient(
      '{"title":"Retreat","startAt":"2026-09-08","endAt":null,"allDay":false,"location":null,"attendees":[]}',
    );
    const r = await parseEventInput(client, 'retreat next Tuesday', { model: 'm', now: NOW });
    expect(r.startAt).toBe('2026-09-08T09:00');
    expect(r.endAt).toBe('2026-09-08T10:00');
  });

  it('keeps date-only start/end untouched when allDay is true', async () => {
    const client = mockClient(
      '{"title":"Public holiday","startAt":"2026-09-08","endAt":"2026-09-08","allDay":true,"location":null,"attendees":[]}',
    );
    const r = await parseEventInput(client, 'public holiday', { model: 'm', now: NOW });
    expect(r.allDay).toBe(true);
    expect(r.startAt).toBe('2026-09-08');
    expect(r.endAt).toBe('2026-09-08');
  });

  it('drops attendee strings without @', async () => {
    const client = mockClient(
      '{"title":"t","startAt":null,"endAt":null,"allDay":false,"location":null,"attendees":["Erick","a@b.rw"]}',
    );
    const r = await parseEventInput(client, 'x', { model: 'm', now: NOW });
    expect(r.attendees).toEqual(['a@b.rw']);
  });

  it('caps attendees at 10', async () => {
    const attendees = Array.from({ length: 15 }, (_, i) => `person${i}@risa.gov.rw`);
    const client = mockClient(
      JSON.stringify({ title: 't', startAt: null, endAt: null, allDay: false, location: null, attendees }),
    );
    const r = await parseEventInput(client, 'x', { model: 'm', now: NOW });
    expect(r.attendees).toHaveLength(10);
    expect(r.attendees).toEqual(attendees.slice(0, 10));
  });

  it('salvages JSON wrapped in prose', async () => {
    const client = mockClient(
      'Sure! {"title":"Lunch","startAt":null,"endAt":null,"allDay":false,"location":null,"attendees":[]} hope that helps',
    );
    const r = await parseEventInput(client, 'lunch', { model: 'm', now: NOW });
    expect(r.title).toBe('Lunch');
  });

  it('falls back to raw input as title on garbage', async () => {
    const client = mockClient('not json at all');
    const r = await parseEventInput(client, 'lunch with Yves', { model: 'm', now: NOW });
    expect(r).toEqual({ title: 'lunch with Yves', startAt: null, endAt: null, allDay: false, location: null, attendees: [] });
  });

  it('falls back to raw input as title when client.chat rejects', async () => {
    const client = rejectingClient();
    const r = await parseEventInput(client, '  buy stamps  ', { model: 'm', now: NOW });
    expect(r).toEqual({ title: 'buy stamps', startAt: null, endAt: null, allDay: false, location: null, attendees: [] });
  });

  it('falls back to raw input when the model returns an empty title', async () => {
    const client = mockClient(
      '{"title":"","startAt":null,"endAt":null,"allDay":false,"location":null,"attendees":[]}',
    );
    const r = await parseEventInput(client, 'quick sync tmrw', { model: 'm', now: NOW });
    expect(r.title).toBe('quick sync tmrw');
  });
});

describe('parseEventFromEmail', () => {
  it('parses a full event from an email', async () => {
    const client = mockClient(
      '{"title":"Budget review","startAt":"2026-09-09T14:00","endAt":"2026-09-09T15:00","allDay":false,"location":"Room 4","attendees":["finance@risa.gov.rw"]}',
    );
    const r = await parseEventFromEmail(
      client,
      { subject: 'Budget review', from: 'finance@risa.gov.rw', bodyText: 'Let us meet Wednesday 2-3pm in Room 4.' },
      { model: 'm', now: NOW },
    );
    expect(r).not.toBeNull();
    expect(r?.title).toBe('Budget review');
    expect(r?.startAt).toBe('2026-09-09T14:00');
    expect(r?.attendees).toEqual(['finance@risa.gov.rw']);
  });

  it('returns null on garbage', async () => {
    const client = mockClient('not json at all');
    const r = await parseEventFromEmail(
      client,
      { subject: 'Re: hi', from: 'a@b.rw', bodyText: 'no event here' },
      { model: 'm', now: NOW },
    );
    expect(r).toBeNull();
  });

  it('returns null when client.chat rejects', async () => {
    const client = rejectingClient();
    const r = await parseEventFromEmail(
      client,
      { subject: 'Re: hi', from: 'a@b.rw', bodyText: 'no event here' },
      { model: 'm', now: NOW },
    );
    expect(r).toBeNull();
  });

  it('falls back to the email subject when the model returns an empty title', async () => {
    const client = mockClient(
      '{"title":"","startAt":null,"endAt":null,"allDay":false,"location":null,"attendees":[]}',
    );
    const r = await parseEventFromEmail(
      client,
      { subject: 'Budget sync', from: 'a@b.rw', bodyText: "let's meet" },
      { model: 'm', now: NOW },
    );
    expect(r?.title).toBe('Budget sync');
  });
});
