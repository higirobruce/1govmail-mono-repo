import { RetrievalService } from './retrieval.service';

const vec = Array.from({ length: 1024 }, () => 0.5);
const DAY_MS = 86_400_000;

function vecRow(id: string, over: Record<string, unknown> = {}) {
  return {
    messageId: id, chunkText: `chunk for ${id}`, subject: `subj ${id}`,
    fromEmail: 'a@x.rw', fromName: 'A', receivedAt: new Date(), snippet: `snip ${id}`,
    isRead: true, hasAttachments: false, distance: 0.2, ...over,
  };
}

function docRow(id: string, over: Record<string, unknown> = {}) {
  return {
    documentId: id, chunkText: `doc chunk for ${id}`, title: `Doc ${id}`,
    emoji: null, updatedAt: new Date(), distance: 0.2, ...over,
  };
}

function attachmentRow(id: string, over: Record<string, unknown> = {}) {
  return {
    messageId: id, chunkText: `attachment chunk for ${id}`, filename: `file-${id}.pdf`,
    subject: `subj ${id}`, fromEmail: 'a@x.rw', fromName: 'A', receivedAt: new Date(), distance: 0.2, ...over,
  };
}

function eventRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id, title: `Event ${id}`, description: null, location: null, organizer: null,
    attendees: [], startAt: new Date(), endAt: new Date(), ...over,
  };
}

function makeFakes() {
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    messageCard: { findMany: jest.fn().mockResolvedValue([]) },
    calendarEvent: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const embedder = { model: 'bge-m3:latest', dims: 1024, embed: jest.fn().mockResolvedValue([vec]) };
  const mailService = {
    searchMessages: jest.fn().mockResolvedValue({ messages: [], total: 0, hasMore: false }),
    getMessage: jest.fn().mockResolvedValue(null),
  };
  return { prisma, embedder, mailService };
}

/** Routes $queryRaw by which table appears in the tagged-template SQL text. */
function routeQueryRaw(
  prisma: ReturnType<typeof makeFakes>['prisma'],
  opts: { mail?: any[]; doc?: any[] | Error; attachment?: any[] | Error },
) {
  prisma.$queryRaw.mockImplementation((strings: TemplateStringsArray) => {
    const sql = strings.join('');
    if (sql.includes('attachment_embeddings')) {
      if (opts.attachment instanceof Error) return Promise.reject(opts.attachment);
      return Promise.resolve(opts.attachment ?? []);
    }
    if (sql.includes('document_embeddings')) {
      if (opts.doc instanceof Error) return Promise.reject(opts.doc);
      return Promise.resolve(opts.doc ?? []);
    }
    return Promise.resolve(opts.mail ?? []);
  });
}

describe('RetrievalService.retrieve — mail legs (scoped to mail so docs/calendar stay inert)', () => {
  const MAIL_ONLY = { types: ['mail'] as ('mail' | 'doc' | 'event')[] };

  it('embeds the question and runs a per-user cosine query', async () => {
    const { prisma, embedder, mailService } = makeFakes();
    prisma.$queryRaw.mockResolvedValue([vecRow('m1')]);
    const svc = new RetrievalService(prisma as any, embedder as any, mailService as any);

    const result = await svc.retrieve('user1', 'user1@x.rw', 'what did finance say about the budget?', MAIL_ONLY);

    expect(embedder.embed).toHaveBeenCalledWith(['what did finance say about the budget?']);
    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(result.sources[0]).toMatchObject({ type: 'mail', id: 'm1', context: 'chunk for m1' });
    expect(result.degraded).toEqual({ vector: false, keyword: false, docs: false, calendar: false, attachment: false });
  });

  it('scopes the vector query to the embedder\'s current model, excluding stale other-model rows', async () => {
    const { prisma, embedder, mailService } = makeFakes();
    prisma.$queryRaw.mockResolvedValue([vecRow('m1')]);
    const svc = new RetrievalService(prisma as any, embedder as any, mailService as any);

    await svc.retrieve('user1', 'user1@x.rw', 'budget', MAIL_ONLY);

    const [strings, ...values] = prisma.$queryRaw.mock.calls[0];
    expect(strings.join('')).toContain('e."model" =');
    expect(values).toContain(embedder.model);
  });

  it('sends extracted keywords (not the raw question) to the Zimbra leg, scoped to 90 days', async () => {
    const { prisma, embedder, mailService } = makeFakes();
    const svc = new RetrievalService(prisma as any, embedder as any, mailService as any);

    await svc.retrieve('user1', 'user1@x.rw', 'what did finance say about the budget?', MAIL_ONLY);

    const [, query, limit] = mailService.searchMessages.mock.calls[0];
    expect(query).toContain('finance');
    expect(query).toContain('budget');
    expect(query).not.toMatch(/\bwhat\b/);
    expect(query).toMatch(/after:\d{1,2}\/\d{1,2}\/\d{4}/);
    expect(limit).toBe(10);
  });

  it('skips the keyword leg entirely when no keywords survive', async () => {
    const { prisma, embedder, mailService } = makeFakes();
    const svc = new RetrievalService(prisma as any, embedder as any, mailService as any);
    await svc.retrieve('user1', 'user1@x.rw', 'what is the', MAIL_ONLY);
    expect(mailService.searchMessages).not.toHaveBeenCalled();
  });

  it('fuses both mail legs, ranking a double-hit first, and keeps the vector chunkText as context', async () => {
    const { prisma, embedder, mailService } = makeFakes();
    prisma.$queryRaw.mockResolvedValue([vecRow('m1'), vecRow('m2')]);
    mailService.searchMessages.mockResolvedValue({
      messages: [
        { id: 'm9', subject: 's9', fromEmail: 'b@x.rw', fromName: null, receivedAt: new Date(), snippet: 'kw snip', bodyText: null, bodyHtml: null },
        { id: 'm2', subject: 's2', fromEmail: 'c@x.rw', fromName: null, receivedAt: new Date(), snippet: 'dup', bodyText: null, bodyHtml: null },
      ],
    });
    const svc = new RetrievalService(prisma as any, embedder as any, mailService as any);

    const result = await svc.retrieve('user1', 'user1@x.rw', 'budget finance', MAIL_ONLY);

    expect(result.sources[0].id).toBe('m2'); // hit by both legs
    const m2 = result.sources.find((s) => s.id === 'm2')!;
    expect(m2.context).toBe('chunk for m2'); // vector payload wins dedupe
    expect(result.sources.map((s) => s.id)).toContain('m9');
  });

  it('uses cached bodyText via extractEmailText for keyword-only hits, snippet as last resort', async () => {
    const { prisma, embedder, mailService } = makeFakes();
    mailService.searchMessages.mockResolvedValue({
      messages: [
        { id: 'k1', subject: 's', fromEmail: 'a@x.rw', fromName: null, receivedAt: new Date(), snippet: 'the snippet', bodyText: 'A cached body.', bodyHtml: null },
        { id: 'k2', subject: 's', fromEmail: 'a@x.rw', fromName: null, receivedAt: new Date(), snippet: 'only snippet', bodyText: null, bodyHtml: null },
      ],
    });
    mailService.getMessage.mockRejectedValue(new Error('hydration down')); // degrade to snippet
    const svc = new RetrievalService(prisma as any, embedder as any, mailService as any);

    const result = await svc.retrieve('user1', 'user1@x.rw', 'budget finance', MAIL_ONLY);

    expect(result.sources.find((s) => s.id === 'k1')!.context).toContain('A cached body.');
    expect(result.sources.find((s) => s.id === 'k2')!.context).toBe('only snippet');
  });

  it('flags injectionSuspected from the message card', async () => {
    const { prisma, embedder, mailService } = makeFakes();
    prisma.$queryRaw.mockResolvedValue([vecRow('m1')]);
    prisma.messageCard.findMany.mockResolvedValue([{ messageId: 'm1', injectionSuspected: true }]);
    const svc = new RetrievalService(prisma as any, embedder as any, mailService as any);
    const result = await svc.retrieve('user1', 'user1@x.rw', 'budget', MAIL_ONLY);
    expect(result.sources[0].injectionSuspected).toBe(true);
  });

  it('degrades to the surviving leg when one throws, and reports both-degraded with zero sources', async () => {
    const { prisma, embedder, mailService } = makeFakes();
    prisma.$queryRaw.mockRejectedValue(new Error('pg down'));
    mailService.searchMessages.mockResolvedValue({
      messages: [{ id: 'k1', subject: 's', fromEmail: 'a@x.rw', fromName: null, receivedAt: new Date(), snippet: 'snip', bodyText: 'body', bodyHtml: null }],
    });
    const svc = new RetrievalService(prisma as any, embedder as any, mailService as any);

    const result = await svc.retrieve('user1', 'user1@x.rw', 'budget finance', MAIL_ONLY);
    expect(result.degraded.vector).toBe(true);
    expect(result.sources).toHaveLength(1);

    mailService.searchMessages.mockRejectedValue(new Error('zimbra down'));
    const both = await svc.retrieve('user1', 'user1@x.rw', 'budget finance', MAIL_ONLY);
    expect(both.degraded).toEqual({ vector: true, keyword: true, docs: false, calendar: false, attachment: true });
    expect(both.sources).toHaveLength(0);
  });
});

describe('RetrievalService.retrieve — attachment leg', () => {
  const MAIL_ONLY = { types: ['mail'] as ('mail' | 'doc' | 'event')[] };

  it('fuses an attachment row with a body row for the SAME messageId into ONE source, keeping the vector chunk as context (vector leg listed first)', async () => {
    const { prisma, embedder, mailService } = makeFakes();
    routeQueryRaw(prisma, { mail: [vecRow('m1')], attachment: [attachmentRow('m1')] });
    const svc = new RetrievalService(prisma as any, embedder as any, mailService as any);

    const result = await svc.retrieve('user1', 'user1@x.rw', 'budget', MAIL_ONLY);

    expect(result.sources.filter((s) => s.id === 'm1')).toHaveLength(1);
    expect(result.sources.find((s) => s.id === 'm1')!.context).toBe('chunk for m1');
  });

  it('surfaces an attachment-only hit (body legs missed it) with context prefixed by the filename', async () => {
    const { prisma, embedder, mailService } = makeFakes();
    routeQueryRaw(prisma, { mail: [], attachment: [attachmentRow('m2', { filename: 'report.pdf', chunkText: 'the Q3 numbers' })] });
    const svc = new RetrievalService(prisma as any, embedder as any, mailService as any);

    const result = await svc.retrieve('user1', 'user1@x.rw', 'budget', MAIL_ONLY);

    const hit = result.sources.find((s) => s.id === 'm2');
    expect(hit).toBeDefined();
    expect(hit!.context.startsWith('[from attachment "report.pdf"]')).toBe(true);
  });

  it('sets degraded.attachment when the attachment SQL rejects, while the other legs still return', async () => {
    const { prisma, embedder, mailService } = makeFakes();
    routeQueryRaw(prisma, { mail: [vecRow('m1')], attachment: new Error('attachment query down') });
    const svc = new RetrievalService(prisma as any, embedder as any, mailService as any);

    const result = await svc.retrieve('user1', 'user1@x.rw', 'budget', MAIL_ONLY);

    expect(result.degraded).toEqual({ vector: false, keyword: false, docs: false, calendar: false, attachment: true });
    expect(result.sources.some((s) => s.id === 'm1')).toBe(true);
  });

  it('does NOT run the attachment leg when scope.docId is set (docs-only scope)', async () => {
    const { prisma, embedder, mailService } = makeFakes();
    prisma.$queryRaw.mockResolvedValue([docRow('doc123')]);
    const svc = new RetrievalService(prisma as any, embedder as any, mailService as any);

    await svc.retrieve('user1', 'user1@x.rw', 'question', { docId: 'doc123' });

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1); // only the docs query — no attachment query
    const [strings] = prisma.$queryRaw.mock.calls[0];
    expect(strings.join('')).not.toContain('attachment_embeddings');
  });

  describe('searchAttachments', () => {
    it('dedupes to one row per (messageId, filename) and clamps the snippet to 200 chars', async () => {
      const { prisma, embedder, mailService } = makeFakes();
      const longText = 'x'.repeat(250);
      prisma.$queryRaw.mockResolvedValue([
        attachmentRow('m1', { filename: 'report.pdf', chunkText: longText, distance: 0.1 }),
        attachmentRow('m1', { filename: 'report.pdf', chunkText: 'worse chunk, same file', distance: 0.5 }),
        attachmentRow('m1', { filename: 'other.pdf', chunkText: 'a different attachment', distance: 0.2 }),
      ]);
      const svc = new RetrievalService(prisma as any, embedder as any, mailService as any);

      const out = await svc.searchAttachments('user1', 'budget');

      expect(out).toHaveLength(2);
      const report = out.find((r) => r.filename === 'report.pdf')!;
      expect(report.snippet).toHaveLength(200);
      expect(report.snippet).toBe(longText.slice(0, 200));
      expect(out.some((r) => r.filename === 'other.pdf')).toBe(true);
    });
  });
});

describe('RetrievalService.retrieve — docs leg', () => {
  it('runs the docs-leg SQL with userId AND userEmail params, including the invite EXISTS predicate', async () => {
    const { prisma, embedder, mailService } = makeFakes();
    const svc = new RetrievalService(prisma as any, embedder as any, mailService as any);

    await svc.retrieve('user1', 'user1@x.rw', 'policy budget question', { types: ['doc'] });

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = prisma.$queryRaw.mock.calls[0];
    const sql = strings.join('');
    expect(sql).toContain('FROM "document_embeddings"');
    expect(sql).toContain('JOIN "documents"');
    expect(sql).toContain('EXISTS');
    expect(sql).toContain('"document_invites"');
    expect(sql).toContain('"invitedEmail"');
    expect(values).toContain('user1');
    expect(values).toContain('user1@x.rw');
  });

  it('scope.types=[doc] skips the mail vector/keyword legs and the calendar leg entirely', async () => {
    const { prisma, embedder, mailService } = makeFakes();
    prisma.$queryRaw.mockResolvedValue([docRow('d1')]);
    const svc = new RetrievalService(prisma as any, embedder as any, mailService as any);

    const result = await svc.retrieve('user1', 'user1@x.rw', 'question', { types: ['doc'] });

    expect(mailService.searchMessages).not.toHaveBeenCalled();
    expect(prisma.calendarEvent.findMany).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1); // only the docs query — no mail vector query
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ type: 'doc', id: 'd1', context: 'doc chunk for d1' });
  });

  it('scope.docId narrows the docs-leg SQL with an e."documentId" filter, forces docs-only, and KEEPS the ACL predicate (owner-OR-invite) in that same query', async () => {
    const { prisma, embedder, mailService } = makeFakes();
    prisma.$queryRaw.mockResolvedValue([docRow('doc123')]);
    const svc = new RetrievalService(prisma as any, embedder as any, mailService as any);

    await svc.retrieve('user1', 'user1@x.rw', 'question', { docId: 'doc123' });

    expect(mailService.searchMessages).not.toHaveBeenCalled();
    expect(prisma.calendarEvent.findMany).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1); // ONE query — docId narrowing is not a second branch
    const [strings, ...values] = prisma.$queryRaw.mock.calls[0];
    const sql = strings.join('');
    expect(sql).toContain('e."documentId" =');
    // The ACL predicate must survive in the docId-scoped path too — this is
    // the regression the reviewer flagged: a future edit that special-cases
    // docId must not be able to drop owner-OR-invite while this still passes.
    expect(sql).toContain('EXISTS');
    expect(sql).toContain('"document_invites"');
    expect(sql).toContain('"invitedEmail"');
    expect(sql).toContain('d."userId" =');
    expect(values).toContain('doc123');
    expect(values).toContain('user1'); // userId, bound for the ACL's owner check
    expect(values).toContain('user1@x.rw'); // userEmail, bound for the ACL's invite check
  });

  it('dedupes doc hits by documentId, keeping the best (first, distance-ordered) chunk', async () => {
    const { prisma, embedder, mailService } = makeFakes();
    prisma.$queryRaw.mockResolvedValue([
      docRow('d1', { chunkText: 'best chunk', distance: 0.1 }),
      docRow('d1', { chunkText: 'worse chunk', distance: 0.5 }),
    ]);
    const svc = new RetrievalService(prisma as any, embedder as any, mailService as any);

    const result = await svc.retrieve('user1', 'user1@x.rw', 'question', { types: ['doc'] });

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].context).toBe('best chunk');
  });

  it('scope.docId joins the top 6 chunks of that ONE doc into a single deep context past the normal 1200-char clamp, at real embedding chunk size (~1500 chars)', async () => {
    const { prisma, embedder, mailService } = makeFakes();
    // Real doc-embedding chunks are packed up to EMBED_CHUNK_MAX_CHARS (1500) each.
    // Build 6 mocked chunks at that size so the assembled context (6 * 1500 +
    // separators ≈ 9025 chars) exercises the real clamp instead of a
    // toy-sized one — a too-small DOC_SCOPED_MAX_CHARS would truncate the
    // tail of chunk 6, which the sentinel below would catch.
    const chunkRows = Array.from({ length: 6 }, (_, i) =>
      docRow('d1', { chunkText: `chunk-${i + 1}-`.padEnd(1490, 'x') + `-END${i + 1}`, distance: 0.1 + i * 0.01 }),
    );
    prisma.$queryRaw.mockResolvedValue(chunkRows);
    const svc = new RetrievalService(prisma as any, embedder as any, mailService as any);

    const result = await svc.retrieve('user1', 'user1@x.rw', 'question', { docId: 'd1' });

    expect(result.sources).toHaveLength(1);
    const source = result.sources[0];
    expect(source.type).toBe('doc');
    expect(source.id).toBe('d1');
    expect(source.context).toContain('chunk-1-');
    expect(source.context).toContain('chunk-6-');
    // The END-of-chunk-6 sentinel must survive the clamp — proves the cap is
    // derived from the real ~1500-char chunk size, not the old 1200-based one.
    expect(source.context).toContain('-END6');
    expect(source.context.length).toBeGreaterThan(1200);
  });

  it('without docId, two docs with 3 chunks each still dedupe to 2 sources with one (best) chunk each (cross-doc dedupe regression guard)', async () => {
    const { prisma, embedder, mailService } = makeFakes();
    prisma.$queryRaw.mockResolvedValue([
      docRow('d1', { chunkText: 'd1 best', distance: 0.1 }),
      docRow('d1', { chunkText: 'd1 worse', distance: 0.2 }),
      docRow('d1', { chunkText: 'd1 worst', distance: 0.3 }),
      docRow('d2', { chunkText: 'd2 best', distance: 0.15 }),
      docRow('d2', { chunkText: 'd2 worse', distance: 0.25 }),
      docRow('d2', { chunkText: 'd2 worst', distance: 0.35 }),
    ]);
    const svc = new RetrievalService(prisma as any, embedder as any, mailService as any);

    const result = await svc.retrieve('user1', 'user1@x.rw', 'question', { types: ['doc'] });

    expect(result.sources).toHaveLength(2);
    expect(result.sources.find((s) => s.id === 'd1')?.context).toBe('d1 best');
    expect(result.sources.find((s) => s.id === 'd2')?.context).toBe('d2 best');
  });
});

describe('RetrievalService.retrieve — calendar leg', () => {
  it('skips the calendar leg entirely when no keywords survive', async () => {
    const { prisma, embedder, mailService } = makeFakes();
    const svc = new RetrievalService(prisma as any, embedder as any, mailService as any);
    await svc.retrieve('user1', 'user1@x.rw', 'what is the', { types: ['event'] });
    expect(prisma.calendarEvent.findMany).not.toHaveBeenCalled();
  });

  it('queries the [-30d, +90d] window for the user and matches keyword in title or attendees JSON', async () => {
    const { prisma, embedder, mailService } = makeFakes();
    const now = Date.now();
    prisma.calendarEvent.findMany.mockResolvedValue([
      eventRow('e1', { title: 'Budget review', startAt: new Date(now + 2 * DAY_MS), endAt: new Date(now + 2 * DAY_MS) }),
      eventRow('e2', { title: 'Standup', attendees: [{ email: 'budget@x.rw', name: 'Budget Bot' }], startAt: new Date(now + 3 * DAY_MS), endAt: new Date(now + 3 * DAY_MS) }),
      eventRow('e3', { title: 'Unrelated topic', startAt: new Date(now + 1 * DAY_MS), endAt: new Date(now + 1 * DAY_MS) }),
    ]);
    const svc = new RetrievalService(prisma as any, embedder as any, mailService as any);

    const result = await svc.retrieve('user1', 'user1@x.rw', 'budget', { types: ['event'] });

    const [args] = prisma.calendarEvent.findMany.mock.calls;
    expect(args[0].where.userId).toBe('user1');
    const gte: Date = args[0].where.startAt.gte;
    const lte: Date = args[0].where.startAt.lte;
    expect(Math.abs(now - gte.getTime() - 30 * DAY_MS)).toBeLessThan(60_000);
    expect(Math.abs(lte.getTime() - now - 90 * DAY_MS)).toBeLessThan(60_000);

    const ids = result.sources.map((s) => s.id);
    expect(ids).toContain('e1'); // keyword in title
    expect(ids).toContain('e2'); // keyword only in attendees JSON
    expect(ids).not.toContain('e3');
    const e1 = result.sources.find((s) => s.id === 'e1')!;
    expect(e1.context).toMatch(/^Event: Budget review\nWhen: /);
    expect(e1.meta).toBe(e1.context.split('\n')[1].replace('When: ', ''));
  });

  it('stopword-filters the terms split out of a quoted phrase: "the budget" matches on budget only', async () => {
    const { prisma, embedder, mailService } = makeFakes();
    const now = Date.now();
    prisma.calendarEvent.findMany.mockResolvedValue([
      eventRow('e1', { title: 'Budget review', startAt: new Date(now + 2 * DAY_MS), endAt: new Date(now + 2 * DAY_MS) }),
      // Contains "the" but nothing about the budget — must not match, i.e. the
      // phrase's leading stopword is dropped rather than matched as a term.
      eventRow('e2', { title: 'Weekly sync', description: 'Walk through the roadmap', startAt: new Date(now + 3 * DAY_MS), endAt: new Date(now + 3 * DAY_MS) }),
    ]);
    const svc = new RetrievalService(prisma as any, embedder as any, mailService as any);

    const result = await svc.retrieve('user1', 'user1@x.rw', '"the budget"', { types: ['event'] });

    expect(result.sources.map((s) => s.id)).toEqual(['e1']);
  });

  it('orders matches by proximity to now and caps at 5', async () => {
    const { prisma, embedder, mailService } = makeFakes();
    const now = Date.now();
    const offsetsDays = [40, 5, 60, 1, 20, 10]; // 6 matching rows, unsorted
    prisma.calendarEvent.findMany.mockResolvedValue(
      offsetsDays.map((d, i) => eventRow(`e${i}`, {
        title: 'Budget sync', startAt: new Date(now + d * DAY_MS), endAt: new Date(now + d * DAY_MS),
      })),
    );
    const svc = new RetrievalService(prisma as any, embedder as any, mailService as any);

    const result = await svc.retrieve('user1', 'user1@x.rw', 'budget', { types: ['event'] });

    expect(result.sources).toHaveLength(5);
    const ordered = [...offsetsDays].sort((a, b) => a - b).slice(0, 5).map((d) => `e${offsetsDays.indexOf(d)}`);
    expect(result.sources.map((s) => s.id)).toEqual(ordered);
  });
});

describe('RetrievalService.retrieve — degraded flags and typed-key fusion', () => {
  it('one leg (docs) rejecting sets only degraded.docs while mail/keyword sources still flow', async () => {
    const { prisma, embedder, mailService } = makeFakes();
    routeQueryRaw(prisma, { mail: [vecRow('m1')], doc: new Error('doc query down') });
    const svc = new RetrievalService(prisma as any, embedder as any, mailService as any);

    const result = await svc.retrieve('user1', 'user1@x.rw', 'budget');

    expect(result.degraded).toEqual({ vector: false, keyword: false, docs: true, calendar: false, attachment: false });
    expect(result.sources.some((s) => s.type === 'mail' && s.id === 'm1')).toBe(true);
  });

  it('typed keys prevent collision — a mail hit and a doc hit sharing the same id both survive fusion', async () => {
    const { prisma, embedder, mailService } = makeFakes();
    const sameId = 'shared123';
    routeQueryRaw(prisma, { mail: [vecRow(sameId)], doc: [docRow(sameId)] });
    const svc = new RetrievalService(prisma as any, embedder as any, mailService as any);

    const result = await svc.retrieve('user1', 'user1@x.rw', 'budget');

    const mailHit = result.sources.find((s) => s.type === 'mail' && s.id === sameId);
    const docHit = result.sources.find((s) => s.type === 'doc' && s.id === sameId);
    expect(mailHit).toBeDefined();
    expect(docHit).toBeDefined();
  });
});

describe('RetrievalService.retrieve — shared embed() across the mail-vector and docs-vector legs', () => {
  it('embeds the question exactly ONCE for an unscoped retrieve (mail vector + docs vector share it)', async () => {
    const { prisma, embedder, mailService } = makeFakes();
    routeQueryRaw(prisma, { mail: [vecRow('m1')], doc: [docRow('d1')] });
    const svc = new RetrievalService(prisma as any, embedder as any, mailService as any);

    await svc.retrieve('user1', 'user1@x.rw', 'budget');

    expect(embedder.embed).toHaveBeenCalledTimes(1);
    expect(embedder.embed).toHaveBeenCalledWith(['budget']);
  });

  it('an embed failure degrades BOTH vector.vector and vector.docs, while keyword and calendar sources still flow', async () => {
    const { prisma, embedder, mailService } = makeFakes();
    embedder.embed.mockRejectedValue(new Error('ollama down'));
    mailService.searchMessages.mockResolvedValue({
      messages: [{ id: 'k1', subject: 's', fromEmail: 'a@x.rw', fromName: null, receivedAt: new Date(), snippet: 'snip', bodyText: 'body', bodyHtml: null }],
    });
    prisma.calendarEvent.findMany.mockResolvedValue([eventRow('e1', { title: 'budget sync' })]);
    const svc = new RetrievalService(prisma as any, embedder as any, mailService as any);

    const result = await svc.retrieve('user1', 'user1@x.rw', 'budget');

    expect(result.degraded).toEqual({ vector: true, keyword: false, docs: true, calendar: false, attachment: true });
    expect(prisma.$queryRaw).not.toHaveBeenCalled(); // neither vector query ever runs without an embedding
    expect(result.sources.some((s) => s.type === 'mail' && s.id === 'k1')).toBe(true);
    expect(result.sources.some((s) => s.type === 'event' && s.id === 'e1')).toBe(true);
  });
});
