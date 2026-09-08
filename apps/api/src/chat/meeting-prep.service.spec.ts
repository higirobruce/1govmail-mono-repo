import { NotFoundException } from '@nestjs/common';
import { MeetingPrepService } from './meeting-prep.service';

const EVENT = {
  id: 'e1', title: 'Budget review', description: 'Q3 numbers', location: 'Room 2',
  organizer: 'me@risa.gov.rw', startAt: new Date('2026-09-08T08:00:00Z'), endAt: new Date('2026-09-08T09:00:00Z'),
  updatedAt: new Date('2026-09-05T00:00:00Z'),
  attendees: [{ email: 'me@risa.gov.rw' }, { email: 'JD@gov.rw', name: 'J D' }, { email: 'ak@gov.rw' }],
  linkedMessageId: null,
};

function makeDeps() {
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue({ email: 'me@risa.gov.rw', displayName: 'Bruce', aiProfile: null }) },
    calendarEvent: { findFirst: jest.fn().mockResolvedValue(EVENT) },
    message: { findFirst: jest.fn().mockResolvedValue(null) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  } as any;
  const retrieval = { retrieve: jest.fn().mockResolvedValue({ sources: [], degraded: { vector: false, keyword: false, docs: false, calendar: false } }) } as any;
  return { prisma, retrieval };
}

describe('MeetingPrepService.prepare', () => {
  it('404s on an event that is missing or not the caller - before any retrieval', async () => {
    const { prisma, retrieval } = makeDeps();
    prisma.calendarEvent.findFirst.mockResolvedValue(null);
    await expect(new MeetingPrepService(prisma, retrieval).prepare('u1', 'nope'))
      .rejects.toThrow(NotFoundException);
    expect(retrieval.retrieve).not.toHaveBeenCalled();
  });

  it('always includes the event itself as the first source and excludes self from attendees', async () => {
    const { prisma, retrieval } = makeDeps();
    const p = await new MeetingPrepService(prisma, retrieval).prepare('u1', 'e1');
    expect(p.kind).toBe('meeting_prep');
    expect(p.targetKey).toBe('e1');
    expect(p.sources[0].type).toBe('event');
    // attendee mail leg queried with lowercased non-self emails
    const sqlCalls = prisma.$queryRaw.mock.calls.flat().map(String).join(' ');
    expect(sqlCalls).not.toContain('me@risa.gov.rw');
  });

  it('runs the retrieval legs scoped to mail+doc and folds degraded flags', async () => {
    const { prisma, retrieval } = makeDeps();
    retrieval.retrieve.mockRejectedValue(new Error('embed down'));
    const p = await new MeetingPrepService(prisma, retrieval).prepare('u1', 'e1');
    expect(retrieval.retrieve).toHaveBeenCalledWith('u1', 'me@risa.gov.rw', 'Budget review Q3 numbers', { types: ['mail', 'doc'] });
    expect(p.degraded.retrieval).toBe(true);
    expect(p.upstreamBody).not.toBeNull(); // event source alone still generates
  });

  it('dedupes a retrieval hit that is already an attendee-mail source', async () => {
    const { prisma, retrieval } = makeDeps();
    prisma.$queryRaw.mockResolvedValueOnce([{ // attendee mail leg
      id: 'm1', subject: 's', snippet: 'x', bodyText: 'b', bodyHtml: null,
      fromEmail: 'jd@gov.rw', fromName: null, receivedAt: new Date('2026-09-04T00:00:00Z'),
      gist: null, cardFlag: null,
    }]).mockResolvedValue([]);
    retrieval.retrieve.mockResolvedValue({
      sources: [{ type: 'mail', id: 'm1', title: 's', fromEmail: 'jd@gov.rw', fromName: null,
                  date: new Date('2026-09-04T00:00:00Z'), meta: null, context: 'b', injectionSuspected: false }],
      degraded: { vector: false, keyword: false, docs: false, calendar: false },
    });
    const p = await new MeetingPrepService(prisma, retrieval).prepare('u1', 'e1');
    expect(p.sources.filter((s) => s.id === 'm1')).toHaveLength(1);
  });

  it('anchor = max(event.updatedAt, newest mail source)', async () => {
    const { prisma, retrieval } = makeDeps();
    prisma.$queryRaw.mockResolvedValueOnce([{
      id: 'm1', subject: 's', snippet: 'x', bodyText: 'b', bodyHtml: null,
      fromEmail: 'jd@gov.rw', fromName: null, receivedAt: new Date('2026-09-06T07:00:00Z'),
      gist: null, cardFlag: null,
    }]).mockResolvedValue([]);
    const p = await new MeetingPrepService(prisma, retrieval).prepare('u1', 'e1');
    expect(p.sourceAnchor).toEqual(new Date('2026-09-06T07:00:00Z'));
  });

  it('includes the profile card but strips user instructions (STYLE PREFERENCES) from meeting prep', async () => {
    const { prisma, retrieval } = makeDeps();
    prisma.user.findUnique.mockResolvedValue({
      email: 'me@risa.gov.rw',
      displayName: 'Bruce',
      aiProfile: {
        jobTitle: 'Director of Digital', institution: 'RISA', department: null, language: null,
        instructions: 'Always answer in bullet points only.',
      },
    });
    const p = await new MeetingPrepService(prisma, retrieval).prepare('u1', 'e1');
    const system = p.upstreamBody!.messages[0].content;
    expect(system).toContain('Director of Digital');
    expect(system).not.toContain('STYLE PREFERENCES');
    expect(system).not.toContain('Always answer in bullet points only');
  });
});
