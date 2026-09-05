import { ForbiddenException } from '@nestjs/common';
import { AskService } from './ask.service';

function makeFakes(sources: any[] = [], degraded = { vector: false, keyword: false, docs: false, calendar: false }) {
  const retrieval = { retrieve: jest.fn().mockResolvedValue({ sources, degraded }) };
  const prisma = { user: { findUnique: jest.fn().mockResolvedValue({ email: 'u1@x.rw' }) } };
  const docsService = { verifyReadAccess: jest.fn().mockResolvedValue({ id: 'd1' }) };
  return { retrieval, prisma, docsService };
}

const MAIL_SRC = {
  type: 'mail' as const, id: 'm1', title: 'Budget', fromEmail: 'f@x.rw', fromName: 'Fin',
  date: new Date('2026-09-01T08:00:00Z'), context: 'Finance approved the Q3 budget.', injectionSuspected: false,
};

const DOC_SRC = {
  type: 'doc' as const, id: 'd1', title: 'Policy Brief', meta: '📄',
  date: new Date('2026-09-02T08:00:00Z'), context: 'This policy covers procurement.', injectionSuspected: false,
};

describe('AskService.prepare', () => {
  const turns = [{ role: 'user' as const, content: 'What did finance say about the budget?' }];

  it('retrieves on the LAST user turn, aliasing sources s1..sN', async () => {
    const { retrieval, prisma, docsService } = makeFakes([MAIL_SRC, { ...MAIL_SRC, id: 'm2' }]);
    const svc = new AskService(retrieval as any, prisma as any, docsService as any);
    const prep = await svc.prepare('u1', [
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
      ...turns,
    ]);

    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 'u1' }, select: { email: true } });
    expect(retrieval.retrieve).toHaveBeenCalledWith('u1', 'u1@x.rw', 'What did finance say about the budget?', undefined);
    expect(prep.sources.map((s) => s.alias)).toEqual(['s1', 's2']);
    expect(prep.sources[0]).toMatchObject({ id: 'm1', type: 'mail', snippet: expect.stringContaining('Finance approved') });
    expect((prep.sources[0] as any).context).toBeUndefined(); // full context never ships to the client
    expect(prep.noSourcesReply).toBeNull();
  });

  it('maps a doc source to a typed PublicAskSource: title/meta present, no fromEmail, context stripped', async () => {
    const { retrieval, prisma, docsService } = makeFakes([DOC_SRC]);
    const svc = new AskService(retrieval as any, prisma as any, docsService as any);
    const prep = await svc.prepare('u1', turns);

    expect(prep.sources[0]).toEqual({
      alias: 's1', type: 'doc', id: 'd1', title: 'Policy Brief',
      fromEmail: undefined, fromName: undefined, date: '2026-09-02T08:00:00.000Z',
      meta: '📄', injectionSuspected: false, snippet: 'This policy covers procurement.',
    });
    expect((prep.sources[0] as any).context).toBeUndefined();
  });

  it('passes scope through to retrieve() unchanged', async () => {
    const { retrieval, prisma, docsService } = makeFakes([MAIL_SRC]);
    const svc = new AskService(retrieval as any, prisma as any, docsService as any);
    const scope = { types: ['mail' as const] };
    await svc.prepare('u1', turns, scope);
    expect(retrieval.retrieve).toHaveBeenCalledWith('u1', 'u1@x.rw', 'What did finance say about the budget?', scope);
  });

  describe('scope.docId access gate', () => {
    it('calls DocsService.verifyReadAccess BEFORE retrieve() when scope.docId is set', async () => {
      const { retrieval, prisma, docsService } = makeFakes([DOC_SRC]);
      const svc = new AskService(retrieval as any, prisma as any, docsService as any);
      await svc.prepare('u1', turns, { docId: 'd1' });
      expect(docsService.verifyReadAccess).toHaveBeenCalledWith('u1', 'd1');
      expect(retrieval.retrieve).toHaveBeenCalledWith('u1', 'u1@x.rw', turns[0].content, { docId: 'd1' });
    });

    it('rejects with the ForbiddenException from verifyReadAccess and never calls retrieve()', async () => {
      const { retrieval, prisma, docsService } = makeFakes([DOC_SRC]);
      docsService.verifyReadAccess.mockRejectedValue(new ForbiddenException());
      const svc = new AskService(retrieval as any, prisma as any, docsService as any);

      await expect(svc.prepare('u1', turns, { docId: 'd1' })).rejects.toThrow(ForbiddenException);
      expect(retrieval.retrieve).not.toHaveBeenCalled();
    });

    it('does not call verifyReadAccess when scope has no docId', async () => {
      const { retrieval, prisma, docsService } = makeFakes([MAIL_SRC]);
      const svc = new AskService(retrieval as any, prisma as any, docsService as any);
      await svc.prepare('u1', turns, { types: ['mail'] });
      expect(docsService.verifyReadAccess).not.toHaveBeenCalled();
    });
  });

  it('builds an upstream body: CHAT_MODEL, streaming, temperature 0.2, max_tokens 1024, system prompt with fenced sources', async () => {
    const { retrieval, prisma, docsService } = makeFakes([MAIL_SRC]);
    const svc = new AskService(retrieval as any, prisma as any, docsService as any);
    const prep = await svc.prepare('u1', turns);

    const body = prep.upstreamBody!;
    expect(body.model).toBe(svc.chatModel);
    expect(body.stream).toBe(true);
    expect((body as any).temperature).toBe(0.2);
    expect((body as any).max_tokens).toBe(1024);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('SECURITY RULE');
    expect(body.messages[0].content).toContain('[s1]');
    expect(body.messages[0].content).toMatch(/<<<EMAIL:[0-9a-f]{10}/);
    expect(body.messages.slice(1)).toEqual(turns);
  });

  it('CRITICAL CARRY-FORWARD: clamps a >4000-char turn in the upstream body (prior turns to 1000, last to 2000)', async () => {
    const { retrieval, prisma, docsService } = makeFakes([MAIL_SRC]);
    const svc = new AskService(retrieval as any, prisma as any, docsService as any);
    const long = 'a'.repeat(4500);
    const multiTurn = [
      { role: 'user' as const, content: long },
      { role: 'assistant' as const, content: long },
      { role: 'user' as const, content: long },
    ];

    const prep = await svc.prepare('u1', multiTurn);

    const body = prep.upstreamBody!;
    const [, ...sentTurns] = body.messages;
    expect(sentTurns[0].content.length).toBeLessThanOrEqual(1000);
    expect(sentTurns[1].content.length).toBeLessThanOrEqual(1000);
    expect(sentTurns[2].content.length).toBeLessThanOrEqual(2000);
    expect(sentTurns[0].content.length).toBeLessThan(long.length);
  });

  it('short-circuits with a language-matched canned reply when retrieval is empty', async () => {
    const { retrieval, prisma, docsService } = makeFakes([]);
    const svc = new AskService(retrieval as any, prisma as any, docsService as any);

    const en = await svc.prepare('u1', [{ role: 'user', content: 'what did finance say about the budget?' }]);
    expect(en.upstreamBody).toBeNull();
    expect(en.noSourcesReply).toContain("couldn't find");

    const fr = await svc.prepare('u1', [{ role: 'user', content: "qu'est-ce que les finances ont dit sur le budget?" }]);
    expect(fr.noSourcesReply).toContain('rien trouvé');
  });

  it('falls back to an empty email when the user lookup misses, but still calls retrieve', async () => {
    const { retrieval, prisma, docsService } = makeFakes([MAIL_SRC]);
    prisma.user.findUnique.mockResolvedValue(null);
    const svc = new AskService(retrieval as any, prisma as any, docsService as any);
    await svc.prepare('u1', turns);
    expect(retrieval.retrieve).toHaveBeenCalledWith('u1', '', 'What did finance say about the budget?', undefined);
  });

  it('defaults chatModel to qwen3-30b-16k:latest', () => {
    const { retrieval, prisma, docsService } = makeFakes();
    expect(new AskService(retrieval as any, prisma as any, docsService as any).chatModel).toBe('qwen3-30b-16k:latest');
  });
});
