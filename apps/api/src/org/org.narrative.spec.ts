import { contentHashOf, OrgNarrativeService } from './org.narrative';
import type { OrgItem } from './org.types';

const item = (id: string): OrgItem => ({
  kind: 'meeting', id, title: `Meeting ${id}`,
  at: '2026-10-08T09:00:00.000Z', participantCount: 3, href: `/calendar?event=${id}`,
});
const five = ['a', 'b', 'c', 'd', 'e'].map(item);

function makePrisma(existing: any = null) {
  return {
    orgDigestNarrative: {
      findUnique: jest.fn().mockResolvedValue(existing),
      upsert: jest.fn().mockResolvedValue({}),
    },
  } as any;
}
const makeAi = (text = 'The institution is focused on network readiness.') => ({
  upstream: jest.fn().mockResolvedValue({
    json: async () => ({ choices: [{ message: { content: text } }] }),
  }),
}) as any;

describe('contentHashOf', () => {
  it('is stable regardless of item order', () => {
    expect(contentHashOf([item('a'), item('b')])).toBe(contentHashOf([item('b'), item('a')]));
  });
  it('changes when the items change', () => {
    expect(contentHashOf([item('a')])).not.toBe(contentHashOf([item('a'), item('b')]));
  });
});

describe('OrgNarrativeService', () => {
  // Review Focus #4 — regenerating per view costs a call each time AND gives
  // two colleagues different sentences for identical data.
  it('reuses the cached narrative when the items have not changed', async () => {
    const prisma = makePrisma({
      contentHash: contentHashOf(five), content: 'cached text', generatedAt: new Date(),
    });
    const ai = makeAi();
    const svc = new OrgNarrativeService(prisma, ai);

    await expect(svc.get('risa', 'week', five)).resolves.toBe('cached text');
    expect(ai.upstream).not.toHaveBeenCalled();
  });

  it('regenerates when the items changed', async () => {
    const prisma = makePrisma({ contentHash: 'stale', content: 'old', generatedAt: new Date() });
    const ai = makeAi('fresh text');
    const svc = new OrgNarrativeService(prisma, ai);

    await expect(svc.get('risa', 'week', five)).resolves.toBe('fresh text');
    expect(ai.upstream).toHaveBeenCalled();
    expect(prisma.orgDigestNarrative.upsert).toHaveBeenCalled();
  });

  it('suppresses the narrative below the floor', async () => {
    const prisma = makePrisma();
    const ai = makeAi();
    const svc = new OrgNarrativeService(prisma, ai);

    await expect(svc.get('risa', 'week', [item('a'), item('b')])).resolves.toBeNull();
    expect(ai.upstream).not.toHaveBeenCalled();
  });

  // Review Focus #5 — the page must survive the model being down.
  it('returns null rather than throwing when generation fails', async () => {
    const prisma = makePrisma();
    const ai = { upstream: jest.fn().mockRejectedValue(new Error('model down')) } as any;
    const svc = new OrgNarrativeService(prisma, ai);

    await expect(svc.get('risa', 'week', five)).resolves.toBeNull();
  });

  it('sends the model only titles, dates and counts — never a body', async () => {
    const prisma = makePrisma();
    const ai = makeAi();
    const svc = new OrgNarrativeService(prisma, ai);
    await svc.get('risa', 'week', five);

    const body = ai.upstream.mock.calls[0][0];
    const sent = JSON.stringify(body);
    expect(sent).toContain('Meeting a');
    expect(sent).not.toContain('href');
    expect(sent).not.toContain('/calendar?event=');
  });
});
