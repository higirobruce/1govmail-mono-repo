import { describe, it, expect } from 'vitest';
import { minutesPrefill } from './minutesPrefill';

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
