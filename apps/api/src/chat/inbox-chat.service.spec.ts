import { InboxChatService } from './inbox-chat.service';

function makeFakes(sources: any[] = [], degraded = { vector: false, keyword: false, docs: false, calendar: false }) {
  const retrieval = { retrieve: jest.fn().mockResolvedValue({ sources, degraded }) };
  const prisma = { user: { findUnique: jest.fn().mockResolvedValue({ email: 'u1@x.rw' }) } };
  return { retrieval, prisma };
}

const SRC = {
  type: 'mail' as const, id: 'm1', title: 'Budget', fromEmail: 'f@x.rw', fromName: 'Fin',
  date: new Date('2026-09-01T08:00:00Z'), context: 'Finance approved the Q3 budget.', injectionSuspected: false,
};

describe('InboxChatService.prepare', () => {
  const turns = [{ role: 'user' as const, content: 'What did finance say about the budget?' }];

  it('retrieves on the LAST user turn (mail-only scope), aliasing sources s1..sN', async () => {
    const { retrieval, prisma } = makeFakes([SRC, { ...SRC, id: 'm2' }]);
    const svc = new InboxChatService(retrieval as any, prisma as any);
    const prep = await svc.prepare('u1', [
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
      ...turns,
    ]);

    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 'u1' }, select: { email: true } });
    expect(retrieval.retrieve).toHaveBeenCalledWith('u1', 'u1@x.rw', 'What did finance say about the budget?', { types: ['mail'] });
    expect(prep.sources.map((s) => s.alias)).toEqual(['s1', 's2']);
    expect(prep.sources[0]).toMatchObject({ messageId: 'm1', snippet: expect.stringContaining('Finance approved') });
    expect((prep.sources[0] as any).context).toBeUndefined(); // full context never ships to the client
    expect(prep.noSourcesReply).toBeNull();
  });

  it('builds an upstream body: CHAT_MODEL, streaming, system prompt with fenced sources, clamped turns', async () => {
    const { retrieval, prisma } = makeFakes([SRC]);
    const svc = new InboxChatService(retrieval as any, prisma as any);
    const prep = await svc.prepare('u1', turns);

    const body = prep.upstreamBody!;
    expect(body.model).toBe(svc.chatModel);
    expect(body.stream).toBe(true);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('SECURITY RULE');
    expect(body.messages[0].content).toContain('[s1]');
    expect(body.messages[0].content).toMatch(/<<<EMAIL:[0-9a-f]{10}/);
    expect(body.messages.slice(1)).toEqual(turns);
  });

  it('short-circuits with a language-matched canned reply when retrieval is empty', async () => {
    const { retrieval, prisma } = makeFakes([]);
    const svc = new InboxChatService(retrieval as any, prisma as any);

    const en = await svc.prepare('u1', [{ role: 'user', content: 'what did finance say about the budget?' }]);
    expect(en.upstreamBody).toBeNull();
    expect(en.noSourcesReply).toContain("couldn't find");

    const fr = await svc.prepare('u1', [{ role: 'user', content: "qu'est-ce que les finances ont dit sur le budget?" }]);
    expect(fr.noSourcesReply).toContain('rien trouvé');
  });

  it('falls back to an empty email when the user lookup misses, but still calls retrieve', async () => {
    const { retrieval, prisma } = makeFakes([SRC]);
    prisma.user.findUnique.mockResolvedValue(null);
    const svc = new InboxChatService(retrieval as any, prisma as any);
    await svc.prepare('u1', turns);
    expect(retrieval.retrieve).toHaveBeenCalledWith('u1', '', 'What did finance say about the budget?', { types: ['mail'] });
  });

  it('defaults chatModel to qwen3-30b-16k:latest', () => {
    const { retrieval, prisma } = makeFakes();
    expect(new InboxChatService(retrieval as any, prisma as any).chatModel).toBe('qwen3-30b-16k:latest');
  });
});
