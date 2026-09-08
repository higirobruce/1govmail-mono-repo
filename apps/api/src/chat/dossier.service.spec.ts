import { BadRequestException } from '@nestjs/common';
import { DossierService } from './dossier.service';

const NOW = new Date('2026-09-06T10:00:00Z');
const MAIL_ROW = {
  id: 'm1', subject: 'Budget', snippet: 'snip', bodyText: 'full body', bodyHtml: null,
  fromEmail: 'jd@gov.rw', fromName: 'J D', receivedAt: NOW, gist: null, cardFlag: null,
};

function makePrisma(me: any = { email: 'me@risa.gov.rw', displayName: 'Bruce', aiProfile: null }) {
  return {
    user: { findUnique: jest.fn().mockResolvedValue(me) },
    $queryRaw: jest.fn().mockResolvedValue([]),
    calendarEvent: { findMany: jest.fn().mockResolvedValue([]) },
  } as any;
}

describe('DossierService.prepare', () => {
  it('rejects own address', async () => {
    await expect(new DossierService(makePrisma()).prepare('u1', 'me@risa.gov.rw'))
      .rejects.toThrow(BadRequestException);
  });

  it('falls back with no model call when there is no data at all', async () => {
    const p = await new DossierService(makePrisma()).prepare('u1', 'jd@gov.rw');
    expect(p.upstreamBody).toBeNull();
    expect(p.fallbackReply).toContain('nothing on file');
    expect(p.sources).toEqual([]);
  });

  it('builds mail sources (gist preferred over body), sets anchor to newest mail', async () => {
    const prisma = makePrisma();
    prisma.$queryRaw
      .mockResolvedValueOnce([                                    // mail leg
        { ...MAIL_ROW, gist: 'the gist', cardFlag: false },
        { ...MAIL_ROW, id: 'm0', receivedAt: new Date('2026-09-01T00:00:00Z') },
      ])
      .mockResolvedValueOnce([]);                                 // commitments leg
    const p = await new DossierService(prisma).prepare('u1', 'JD@gov.rw');
    expect(p.targetKey).toBe('jd@gov.rw');
    expect(p.sources).toHaveLength(2);
    expect(p.sources[0].snippet.startsWith('the gist')).toBe(true);
    expect(p.sourceAnchor).toEqual(NOW);
    expect(p.upstreamBody?.messages[0].role).toBe('system');
    expect(p.upstreamBody?.messages[0].content).toContain('relationship brief');
  });

  it('flags injection-suspected sources (card flag OR detector)', async () => {
    const prisma = makePrisma();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ ...MAIL_ROW, cardFlag: true }])
      .mockResolvedValueOnce([]);
    const p = await new DossierService(prisma).prepare('u1', 'jd@gov.rw');
    expect(p.sources[0].injectionSuspected).toBe(true);
  });

  it('degrades a failed leg instead of throwing', async () => {
    const prisma = makePrisma();
    prisma.$queryRaw
      .mockResolvedValueOnce([MAIL_ROW])
      .mockRejectedValueOnce(new Error('boom'));                  // commitments leg fails
    const p = await new DossierService(prisma).prepare('u1', 'jd@gov.rw');
    expect(p.degraded.commitments).toBe(true);
    expect(p.upstreamBody).not.toBeNull();
  });

  it('includes the identity line but NOT the profile card (dossier is identity-tier only)', async () => {
    const prisma = makePrisma({
      email: 'me@risa.gov.rw',
      displayName: 'Bruce',
      aiProfile: { jobTitle: 'Director of Digital', institution: 'RISA', department: null, language: null, instructions: null },
    });
    prisma.$queryRaw
      .mockResolvedValueOnce([MAIL_ROW])
      .mockResolvedValueOnce([]);
    const p = await new DossierService(prisma).prepare('u1', 'jd@gov.rw');
    const system = p.upstreamBody!.messages[0].content;
    expect(system).toContain('me@risa.gov.rw');
    expect(system).not.toContain('Director of Digital');
  });
});
