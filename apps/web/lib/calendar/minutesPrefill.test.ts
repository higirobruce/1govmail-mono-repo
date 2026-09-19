import { describe, it, expect } from 'vitest';
import { minutesPrefill, replaceAttendeeList } from './minutesPrefill';

const EVENT = {
  title: 'Cabinet briefing',
  startAt: '2026-09-17T09:00:00.000Z',
  location: 'Room 3',
  organizer: 'chair@risa.gov.rw',
  attendees: ['a@risa.gov.rw', 'b@risa.gov.rw'],
};

describe('minutesPrefill', () => {
  it('names the document after the meeting', () => {
    expect(minutesPrefill(EVENT).title).toBe('Minutes — Cabinet briefing');
  });

  it('fills the template placeholders from the event', () => {
    const { content } = minutesPrefill(EVENT);
    expect(content).toContain('Cabinet briefing');
    expect(content).toContain('Room 3');
    expect(content).toContain('chair@risa.gov.rw');
    expect(content).toContain('a@risa.gov.rw');
    expect(content).toContain('b@risa.gov.rw');
    // the template's own placeholder text must not survive into a real document
    expect(content).not.toContain('[Title of Meeting]');
    expect(content).not.toContain('[Venue or Video Conference Link]');
  });

  it('is valid TipTap JSON', () => {
    const parsed = JSON.parse(minutesPrefill(EVENT).content);
    expect(parsed.type).toBe('doc');
    expect(Array.isArray(parsed.content)).toBe(true);
  });

  it('survives an event with no location, organizer or attendees', () => {
    const bare = minutesPrefill({ title: 'Standup', startAt: EVENT.startAt });
    expect(bare.title).toBe('Minutes — Standup');
    expect(() => JSON.parse(bare.content)).not.toThrow();
  });

  it('replaces the bullet list that belongs to the Attendees heading', () => {
    const doc = JSON.parse(minutesPrefill(EVENT).content);
    const headingAt = doc.content.findIndex(
      (n: any) => n.type === 'heading' && n.content?.[0]?.text === 'Attendees',
    );

    expect(headingAt).toBeGreaterThan(-1);
    const list = doc.content[headingAt + 1];
    expect(list.type).toBe('bulletList');
    expect(list.content.map((li: any) => li.content[0].content[0].text))
      .toEqual(['a@risa.gov.rw', 'b@risa.gov.rw']);
  });

  it('names the chairperson without claiming who took the notes', () => {
    const { content } = minutesPrefill(EVENT);
    const doc = JSON.parse(content);
    const text = (label: string) =>
      doc.content.find((n: any) => n.content?.[0]?.text?.startsWith(label))
        ?.content?.[1]?.text;

    expect(text('Chairperson:')).toBe('chair@risa.gov.rw');
    expect(text('Minutes Recorder:')).toBe('[Name]');
  });
});

describe('replaceAttendeeList', () => {
  const bullets = (...items: string[]) => ({
    type: 'bulletList',
    content: items.map((t) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] })),
  });
  const heading = (text: string) => ({ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text }] });
  const texts = (list: any) => list.content.map((li: any) => li.content[0].content[0].text);

  it('leaves a bullet list ABOVE the Attendees heading alone', () => {
    // The association used to be positional ("the first bulletList"), which is
    // correct only because today's template happens to have exactly one. A
    // bullet list added anywhere above Attendees would have been clobbered
    // instead, and no assertion on "the emails appear somewhere" catches that.
    const doc = { type: 'doc', content: [
      heading('Apologies'), bullets('[Names]'),
      heading('Attendees'), bullets('[Name, Title]', '[Name, Title]'),
    ] };

    replaceAttendeeList(doc, ['a@risa.gov.rw']);

    expect(texts(doc.content[1])).toEqual(['[Names]']);
    expect(texts(doc.content[3])).toEqual(['a@risa.gov.rw']);
  });

  it('does not reach past the next heading for a list', () => {
    const doc = { type: 'doc', content: [
      heading('Attendees'), { type: 'paragraph', content: [{ type: 'text', text: 'None recorded' }] },
      heading('Agenda'), bullets('[Item]'),
    ] };

    replaceAttendeeList(doc, ['a@risa.gov.rw']);

    expect(texts(doc.content[3])).toEqual(['[Item]']);
  });

  it('is a no-op on a document with no Attendees heading', () => {
    const doc = { type: 'doc', content: [heading('Agenda'), bullets('[Item]')] };

    expect(() => replaceAttendeeList(doc, ['a@risa.gov.rw'])).not.toThrow();
    expect(texts(doc.content[1])).toEqual(['[Item]']);
  });
});
