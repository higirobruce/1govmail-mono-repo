import { BadRequestException, ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { MailService } from './mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { ZimbraService } from '../zimbra/zimbra.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TasksService } from '../tasks/tasks.service';
import { mapZimbraMessage } from '../zimbra/zimbra.mappers';
import { buildMailSession } from '../provider/mail-session';
import { MailProviderResolver } from '../provider/mail-provider.resolver';

// MailService injects the resolver now. Wrapping each existing zimbra mock in
// the REAL resolver keeps every assertion below pointed at the same mock while
// still exercising the provider lookup (which needs a provider-bearing user
// row, exactly as the DB returns).
const makeResolver = (zimbra: any) => new MailProviderResolver(zimbra as ZimbraService);

function makeService() {
  const prisma = {
    user: { findUnique: jest.fn(), update: jest.fn() },
    senderRule: { findMany: jest.fn(), create: jest.fn(), findFirst: jest.fn(), delete: jest.fn() },
  } as unknown as PrismaService;
  const zimbra = {} as ZimbraService;
  const notifications = {} as NotificationsService;
  const tasksService = { create: jest.fn() } as unknown as TasksService;
  const service = new MailService(prisma, makeResolver(zimbra), notifications, tasksService);
  return { service, prisma: prisma as any };
}

describe('MailService sender rules', () => {
  const user = { id: 'u1', authToken: 'tok', tokenExpiry: new Date(Date.now() + 60_000) };

  it('getSenderRules lists rules for the current user', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.senderRule.findMany.mockResolvedValue([{ id: 'r1', type: 'BLOCK', address: '@evil.com' }]);

    const result = await service.getSenderRules('u1');

    expect(prisma.senderRule.findMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      orderBy: { createdAt: 'asc' },
    });
    expect(result).toEqual([{ id: 'r1', type: 'BLOCK', address: '@evil.com' }]);
  });

  it('getSenderRules rejects when the user has no Zimbra session', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ ...user, authToken: null });

    await expect(service.getSenderRules('u1')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('createSenderRule stores a lowercased, trimmed address', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.senderRule.create.mockResolvedValue({ id: 'r1', userId: 'u1', type: 'BLOCK', address: '@evil.com' });

    await service.createSenderRule('u1', { type: 'BLOCK', address: ' @Evil.com ' });

    expect(prisma.senderRule.create).toHaveBeenCalledWith({
      data: { userId: 'u1', type: 'BLOCK', address: '@evil.com' },
    });
  });

  it('deleteSenderRule throws NotFoundException for a rule the user does not own', async () => {
    const { service, prisma } = makeService();
    prisma.senderRule.findFirst.mockResolvedValue(null);

    await expect(service.deleteSenderRule('u1', 'missing-id')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('deleteSenderRule removes an owned rule', async () => {
    const { service, prisma } = makeService();
    prisma.senderRule.findFirst.mockResolvedValue({ id: 'r1', userId: 'u1' });
    prisma.senderRule.delete.mockResolvedValue({});

    const result = await service.deleteSenderRule('u1', 'r1');

    expect(prisma.senderRule.delete).toHaveBeenCalledWith({ where: { id: 'r1' } });
    expect(result).toEqual({ success: true });
  });
});

describe('MailService.enforceSenderRules', () => {
  // The method takes the caller's User row (SenderRuleSweepService passes the
  // one it already loaded): a MailSession alone cannot name a provider, and
  // this method has no userId lookup to resolve one from. It builds the
  // session itself via buildMailSession.
  const user = {
    zimbraHost: 'mail.example.com', email: 'u@example.com',
    authToken: 'tok', csrfToken: 'csrf', provider: 'zimbra',
  };
  const message = { id: 'm1', zimbraId: 'z1', fromEmail: 'spam@evil.com', folderId: 'inbox-id' };

  // `rules` and `junkFolder` are now caller-resolved (hoisted out of the
  // per-message loop in getMessages to kill the N+1 query pattern), so these
  // tests pass them in directly instead of mocking senderRule.findMany /
  // folder.findFirst-for-the-junk-lookup.
  function makeService() {
    const prisma = {
      folder: { findFirst: jest.fn() },
      message: { update: jest.fn() },
    } as unknown as PrismaService;
    const zimbra = { moveMessage: jest.fn() } as unknown as ZimbraService;
    const notifications = {} as NotificationsService;
    const tasksService = { create: jest.fn() } as unknown as TasksService;
    const service = new MailService(prisma, makeResolver(zimbra), notifications, tasksService);
    return { service: service as any, prisma: prisma as any, zimbra: zimbra as any };
  }

  it('does nothing when there are no sender rules', async () => {
    const { service, prisma, zimbra } = makeService();

    await service.enforceSenderRules('u1', user, message, [], { id: 'junk-id', zimbraId: 'z-junk' });

    expect(zimbra.moveMessage).not.toHaveBeenCalled();
    expect(prisma.folder.findFirst).not.toHaveBeenCalled();
  });

  it('does nothing when an ALLOW rule matches', async () => {
    const { service, prisma, zimbra } = makeService();

    await service.enforceSenderRules(
      'u1',
      user,
      message,
      [{ type: 'ALLOW', address: 'spam@evil.com' }],
      { id: 'junk-id', zimbraId: 'z-junk' },
    );

    expect(zimbra.moveMessage).not.toHaveBeenCalled();
  });

  it('does nothing when the message is already in the Junk folder', async () => {
    const { service, prisma, zimbra } = makeService();
    prisma.folder.findFirst.mockResolvedValue({ id: 'inbox-id', path: '/Junk' });

    await service.enforceSenderRules(
      'u1',
      user,
      message,
      [{ type: 'BLOCK', address: '@evil.com' }],
      { id: 'junk-id', zimbraId: 'z-junk' },
    );

    expect(prisma.folder.findFirst).toHaveBeenCalledWith({ where: { userId: 'u1', id: 'inbox-id' } });
    expect(zimbra.moveMessage).not.toHaveBeenCalled();
  });

  it('does nothing when the message is already in the Spam folder (alternate deployment path)', async () => {
    const { service, prisma, zimbra } = makeService();
    prisma.folder.findFirst.mockResolvedValue({ id: 'inbox-id', path: '/Spam' });

    await service.enforceSenderRules(
      'u1',
      user,
      message,
      [{ type: 'BLOCK', address: '@evil.com' }],
      { id: 'junk-id', zimbraId: 'z-junk' },
    );

    expect(zimbra.moveMessage).not.toHaveBeenCalled();
  });

  it('moves a blocked sender\'s message to Junk', async () => {
    const { service, prisma, zimbra } = makeService();
    prisma.folder.findFirst.mockResolvedValue({ id: 'inbox-id', path: '/Inbox' });

    await service.enforceSenderRules(
      'u1',
      user,
      message,
      [{ type: 'BLOCK', address: '@evil.com' }],
      { id: 'junk-id', zimbraId: 'z-junk' },
    );

    expect(zimbra.moveMessage).toHaveBeenCalledWith(buildMailSession(user), 'z1', 'z-junk');
    expect(prisma.message.update).toHaveBeenCalledWith({ where: { id: 'm1' }, data: { folderId: 'junk-id' } });
  });

  it('does nothing and logs a warning when the account has no Junk/Spam folder synced', async () => {
    const { service, prisma, zimbra } = makeService();
    prisma.folder.findFirst.mockResolvedValue({ id: 'inbox-id', path: '/Inbox' });
    const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

    await service.enforceSenderRules('u1', user, message, [{ type: 'BLOCK', address: '@evil.com' }], null);

    expect(zimbra.moveMessage).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('m1'));
  });
});

describe('MailService.getMessages stays a pure read (sender-rule enforcement lives in the sweep)', () => {
  const activeUser = {
    id: 'u1',
    zimbraHost: 'mail.example.com',
    authToken: 'tok',
    csrfToken: 'csrf',
    provider: 'zimbra',
    tokenExpiry: new Date(Date.now() + 60_000),
  };

  function makeService() {
    const prisma = {
      user: { findUnique: jest.fn(), update: jest.fn() },
      folder: { findFirst: jest.fn() },
      message: { upsert: jest.fn(), update: jest.fn() },
      senderRule: { findMany: jest.fn() },
    } as unknown as PrismaService;
    const zimbra = {
      getMessages: jest.fn(),
      moveMessage: jest.fn(),
    } as unknown as ZimbraService;
    const notifications = {} as NotificationsService;
    const tasksService = { create: jest.fn() } as unknown as TasksService;
    const service = new MailService(prisma, makeResolver(zimbra), notifications, tasksService);
    return { service: service as any, prisma: prisma as any, zimbra: zimbra as any };
  }

  it('never runs enforcement inside the Inbox list GET, even with a blocked sender in the results', async () => {
    const { service, prisma, zimbra } = makeService();
    prisma.user.findUnique.mockResolvedValue(activeUser);
    prisma.folder.findFirst.mockResolvedValueOnce({ id: 'inbox-id', zimbraId: 'zfolder', userId: 'u1', path: '/Inbox' });
    zimbra.getMessages.mockResolvedValue({
      messages: [mapZimbraMessage({
        id: 'z1', l: 'zfolder', e: [{ t: 'f', a: 'spam@evil.com', d: 'Spam' }],
        f: '', su: 'Subj', fr: 'snippet', d: Date.now(),
      } as any)],
      total: 1,
      more: false,
    });
    const upserted = { id: 'm1', userId: 'u1', folderId: 'inbox-id', zimbraId: 'z1', fromEmail: 'spam@evil.com' };
    prisma.message.upsert.mockResolvedValue(upserted);

    const result = await service.getMessages('u1', 'inbox-id');

    // The mutating Zimbra call moved to SenderRuleSweepService — an Inbox
    // load must never pay per-message SOAP latency or mutate mail state.
    expect(prisma.senderRule.findMany).not.toHaveBeenCalled();
    expect(zimbra.moveMessage).not.toHaveBeenCalled();
    expect(result.messages).toEqual([upserted]);
  });
});

describe('MailService.getCardsByIds', () => {
  function makeService() {
    const prisma = {
      messageCard: { findMany: jest.fn() },
    } as unknown as PrismaService;
    const zimbra = {} as ZimbraService;
    const notifications = {} as NotificationsService;
    const tasksService = { create: jest.fn() } as unknown as TasksService;
    const service = new MailService(prisma, makeResolver(zimbra), notifications, tasksService);
    return { service: service as any, prisma: prisma as any };
  }

  it('returns a label/importance/injectionSuspected map keyed by messageId', async () => {
    const { service, prisma } = makeService();
    prisma.messageCard.findMany.mockResolvedValue([
      {
        messageId: 'm1',
        asksOfMe: ['Please approve the budget'],
        deadlines: [],
        waitingOn: null,
        importance: 'high',
        injectionSuspected: false,
      },
      {
        messageId: 'm2',
        asksOfMe: [],
        deadlines: [],
        waitingOn: 'their reply',
        importance: 'normal',
        injectionSuspected: true,
      },
    ]);

    const result = await service.getCardsByIds('u1', ['m1', 'm2']);

    expect(prisma.messageCard.findMany).toHaveBeenCalledWith({
      where: { userId: 'u1', messageId: { in: ['m1', 'm2'] }, failed: false },
    });
    expect(result).toEqual({
      cards: {
        m1: { label: 'needsDecision', importance: 'high', injectionSuspected: false },
        m2: { label: 'waitingOnYou', importance: 'normal', injectionSuspected: true },
      },
    });
  });

  it('omits a card belonging to another user (scoped by the where clause)', async () => {
    const { service, prisma } = makeService();
    // The `where: { userId }` clause is what actually enforces scoping — a
    // real DB would never return another user's row here, so the mock
    // reflects that by returning nothing for ids that aren't u1's.
    prisma.messageCard.findMany.mockResolvedValue([]);

    const result = await service.getCardsByIds('u1', ['other-users-message']);

    expect(prisma.messageCard.findMany).toHaveBeenCalledWith({
      where: { userId: 'u1', messageId: { in: ['other-users-message'] }, failed: false },
    });
    expect(result).toEqual({ cards: {} });
  });

  it('excludes tombstoned cards via the failed:false filter', async () => {
    const { service, prisma } = makeService();
    prisma.messageCard.findMany.mockResolvedValue([]);

    await service.getCardsByIds('u1', ['m1']);

    expect(prisma.messageCard.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ failed: false }) }),
    );
  });

  it('rejects more than 100 ids with BadRequestException', async () => {
    const { service } = makeService();
    const ids = Array.from({ length: 101 }, (_, i) => `m${i}`);

    await expect(service.getCardsByIds('u1', ids)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts exactly 100 ids', async () => {
    const { service, prisma } = makeService();
    const ids = Array.from({ length: 100 }, (_, i) => `m${i}`);
    prisma.messageCard.findMany.mockResolvedValue([]);

    await expect(service.getCardsByIds('u1', ids)).resolves.toEqual({ cards: {} });
  });
});

describe('MailService.getWindowCards', () => {
  function makeService() {
    const prisma = {
      messageCard: { findMany: jest.fn() },
    } as unknown as PrismaService;
    const zimbra = {} as ZimbraService;
    const notifications = {} as NotificationsService;
    const tasksService = { create: jest.fn() } as unknown as TasksService;
    const service = new MailService(prisma, makeResolver(zimbra), notifications, tasksService);
    return { service: service as any, prisma: prisma as any };
  }

  const row = {
    messageId: 'm1',
    gist: 'Budget approval needed',
    asksOfMe: ['Approve the budget'],
    deadlines: ['Friday'],
    commitmentsIMade: [],
    waitingOn: null,
    importance: 'high',
    injectionSuspected: false,
    message: {
      conversationId: 'c1',
      subject: 'Budget',
      fromEmail: 'boss@example.com',
      fromName: 'The Boss',
      receivedAt: new Date('2026-09-02T10:00:00.000Z'),
      attachments: [],
      folder: { path: '/Inbox' },
    },
  };

  it('assembles ExtractedCard rows from the message card + its message, deriving direction from folder path', async () => {
    const { service, prisma } = makeService();
    prisma.messageCard.findMany.mockResolvedValue([row]);

    const result = await service.getWindowCards('u1', 'today');

    expect(result.cards).toEqual([
      {
        messageId: 'm1',
        conversationId: 'c1',
        direction: 'received',
        from: 'The Boss <boss@example.com>',
        subject: 'Budget',
        receivedAt: '2026-09-02T10:00:00.000Z',
        gist: 'Budget approval needed',
        asksOfMe: ['Approve the budget'],
        deadlines: ['Friday'],
        commitmentsIMade: [],
        waitingOn: null,
        importance: 'high',
        attachments: [],
        injectionSuspected: false,
      },
    ]);
  });

  it('derives a "sent" direction for messages filed under /Sent', async () => {
    const { service, prisma } = makeService();
    prisma.messageCard.findMany.mockResolvedValue([
      { ...row, message: { ...row.message, folder: { path: '/Sent' } } },
    ]);

    const result = await service.getWindowCards('u1', 'today');

    expect(result.cards[0].direction).toBe('sent');
  });

  it('formats "from" as bare email when the message has no fromName', async () => {
    const { service, prisma } = makeService();
    prisma.messageCard.findMany.mockResolvedValue([
      { ...row, message: { ...row.message, fromName: null } },
    ]);

    const result = await service.getWindowCards('u1', 'today');

    expect(result.cards[0].from).toBe('boss@example.com');
  });

  it('scopes "today" to server midnight', async () => {
    const { service, prisma } = makeService();
    prisma.messageCard.findMany.mockResolvedValue([]);
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);

    await service.getWindowCards('u1', 'today');

    const call = prisma.messageCard.findMany.mock.calls[0][0];
    expect(call.where.userId).toBe('u1');
    expect(call.where.failed).toBe(false);
    expect(call.where.message.receivedAt.gte.getTime()).toBe(midnight.getTime());
    expect(call.where.message.folder.path).toEqual({ in: ['/Inbox', '/Sent'] });
  });

  it('scopes "24h" to now minus 24 hours', async () => {
    const { service, prisma } = makeService();
    prisma.messageCard.findMany.mockResolvedValue([]);
    const before = Date.now() - 24 * 60 * 60 * 1000;

    await service.getWindowCards('u1', '24h');

    const call = prisma.messageCard.findMany.mock.calls[0][0];
    const gte = call.where.message.receivedAt.gte.getTime();
    const after = Date.now() - 24 * 60 * 60 * 1000;
    expect(gte).toBeGreaterThanOrEqual(before - 1000);
    expect(gte).toBeLessThanOrEqual(after + 1000);
  });

  it('scopes "week" to now minus 7 days', async () => {
    const { service, prisma } = makeService();
    prisma.messageCard.findMany.mockResolvedValue([]);
    const before = Date.now() - 7 * 24 * 60 * 60 * 1000;

    await service.getWindowCards('u1', 'week');

    const call = prisma.messageCard.findMany.mock.calls[0][0];
    const gte = call.where.message.receivedAt.gte.getTime();
    const after = Date.now() - 7 * 24 * 60 * 60 * 1000;
    expect(gte).toBeGreaterThanOrEqual(before - 1000);
    expect(gte).toBeLessThanOrEqual(after + 1000);
  });

  it('caps results at 50 via take', async () => {
    const { service, prisma } = makeService();
    prisma.messageCard.findMany.mockResolvedValue([]);

    await service.getWindowCards('u1', 'today');

    expect(prisma.messageCard.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50 }),
    );
  });

  it('orders results newest-first by message.receivedAt', async () => {
    const { service, prisma } = makeService();
    prisma.messageCard.findMany.mockResolvedValue([]);

    await service.getWindowCards('u1', 'today');

    expect(prisma.messageCard.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { message: { receivedAt: 'desc' } } }),
    );
  });

  it('rejects an invalid window value', async () => {
    const { service } = makeService();

    await expect(service.getWindowCards('u1', 'bogus' as any)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('MailService.getCommitments', () => {
  function makeService() {
    const prisma = {
      commitment: { findMany: jest.fn(), count: jest.fn() },
      message: { findMany: jest.fn() },
    } as unknown as PrismaService;
    const zimbra = {} as ZimbraService;
    const notifications = {} as NotificationsService;
    const tasksService = { create: jest.fn() } as unknown as TasksService;
    const service = new MailService(prisma, makeResolver(zimbra), notifications, tasksService);
    return { service: service as any, prisma: prisma as any };
  }

  const promisedRow = {
    id: 'c1',
    userId: 'u1',
    conversationId: 'conv1',
    messageId: 'm1',
    type: 'promised',
    text: 'Send the report',
    dueHint: 'Friday',
    status: 'open',
    suggestResolve: false,
    hintMessageId: null,
    taskId: null,
    textHash: 'hash1',
    extractedAt: new Date('2026-09-01T00:00:00.000Z'),
    lastActivityAt: new Date('2026-09-02T00:00:00.000Z'),
    resolvedAt: null,
  };
  const waitingRow = {
    id: 'c2',
    userId: 'u1',
    conversationId: 'conv2',
    messageId: 'm2',
    type: 'waiting',
    text: 'Their sign-off',
    dueHint: null,
    status: 'open',
    suggestResolve: true,
    hintMessageId: 'm3',
    taskId: null,
    textHash: 'hash2',
    extractedAt: new Date('2026-09-01T00:00:00.000Z'),
    lastActivityAt: new Date('2026-09-03T00:00:00.000Z'),
    resolvedAt: null,
  };

  it('groups rows by type and strips userId/textHash from each DTO', async () => {
    const { service, prisma } = makeService();
    prisma.commitment.findMany.mockResolvedValue([waitingRow, promisedRow]);
    prisma.commitment.count.mockResolvedValue(2);
    prisma.message.findMany.mockResolvedValue([]);

    const result = await service.getCommitments('u1', 'open');

    const { userId: _u1, textHash: _t1, ...promisedRest } = promisedRow;
    const { userId: _u2, textHash: _t2, ...waitingRest } = waitingRow;
    expect(result.promised).toEqual([{ ...promisedRest, counterparty: null }]);
    expect(result.waiting).toEqual([{ ...waitingRest, counterparty: null }]);
    expect(result.promised[0]).not.toHaveProperty('userId');
    expect(result.promised[0]).not.toHaveProperty('textHash');
  });

  it('scopes rows to the caller via the where clause', async () => {
    const { service, prisma } = makeService();
    prisma.commitment.findMany.mockResolvedValue([]);
    prisma.commitment.count.mockResolvedValue(0);

    await service.getCommitments('u1', 'open');

    expect(prisma.commitment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'u1', status: 'open' } }),
    );
    expect(prisma.commitment.count).toHaveBeenCalledWith({ where: { userId: 'u1', status: 'open' } });
  });

  it('filters to the literal archived status for the archived view (the 30-day-idle bucket)', async () => {
    const { service, prisma } = makeService();
    prisma.commitment.findMany.mockResolvedValue([]);
    prisma.commitment.count.mockResolvedValue(0);

    await service.getCommitments('u1', 'archived');

    expect(prisma.commitment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'u1', status: 'archived' } }),
    );
  });

  it('orders by lastActivityAt desc and caps at 200', async () => {
    const { service, prisma } = makeService();
    prisma.commitment.findMany.mockResolvedValue([]);
    prisma.commitment.count.mockResolvedValue(0);

    await service.getCommitments('u1', 'open');

    expect(prisma.commitment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { lastActivityAt: 'desc' }, take: 200 }),
    );
  });

  it('openCount always reflects status=open regardless of the status filter', async () => {
    const { service, prisma } = makeService();
    prisma.commitment.findMany.mockResolvedValue([]);
    prisma.commitment.count.mockResolvedValue(7);

    const result = await service.getCommitments('u1', 'archived');

    expect(prisma.commitment.count).toHaveBeenCalledWith({ where: { userId: 'u1', status: 'open' } });
    expect(result.openCount).toBe(7);
  });

  it('resolves counterparty as a from-label via one batched message.findMany', async () => {
    const { service, prisma } = makeService();
    prisma.commitment.findMany.mockResolvedValue([promisedRow, waitingRow]);
    prisma.commitment.count.mockResolvedValue(2);
    prisma.message.findMany.mockResolvedValue([
      { id: 'm1', fromName: 'Jane Doe', fromEmail: 'jane@example.com' },
      { id: 'm2', fromName: null, fromEmail: 'bare@example.com' },
    ]);

    const result = await service.getCommitments('u1', 'open');

    expect(prisma.message.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.message.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['m1', 'm2'] }, userId: 'u1' },
      select: { id: true, fromName: true, fromEmail: true },
    });
    expect(result.promised[0].counterparty).toBe('Jane Doe <jane@example.com>');
    expect(result.waiting[0].counterparty).toBe('bare@example.com');
  });

  it('sets counterparty null when the source message row is gone', async () => {
    const { service, prisma } = makeService();
    prisma.commitment.findMany.mockResolvedValue([promisedRow]);
    prisma.commitment.count.mockResolvedValue(1);
    prisma.message.findMany.mockResolvedValue([]);

    const result = await service.getCommitments('u1', 'open');

    expect(result.promised[0].counterparty).toBeNull();
  });

  it('rejects an invalid status value', async () => {
    const { service } = makeService();

    await expect(service.getCommitments('u1', 'bogus')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('MailService.updateCommitment', () => {
  function makeService() {
    const prisma = {
      commitment: { findUnique: jest.fn(), update: jest.fn() },
    } as unknown as PrismaService;
    const zimbra = {} as ZimbraService;
    const notifications = {} as NotificationsService;
    const tasksService = { create: jest.fn() } as unknown as TasksService;
    const service = new MailService(prisma, makeResolver(zimbra), notifications, tasksService);
    return { service: service as any, prisma: prisma as any };
  }

  it('throws NotFoundException when the commitment does not exist', async () => {
    const { service, prisma } = makeService();
    prisma.commitment.findUnique.mockResolvedValue(null);

    await expect(service.updateCommitment('u1', 'missing', 'done')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.commitment.update).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when the commitment belongs to another user', async () => {
    const { service, prisma } = makeService();
    prisma.commitment.findUnique.mockResolvedValue({ id: 'c1', userId: 'other-user' });

    await expect(service.updateCommitment('u1', 'c1', 'done')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.commitment.update).not.toHaveBeenCalled();
  });

  it('sets resolvedAt and clears suggestResolve when marking done, and returns the updated row', async () => {
    const { service, prisma } = makeService();
    prisma.commitment.findUnique.mockResolvedValue({ id: 'c1', userId: 'u1' });
    prisma.commitment.update.mockResolvedValue({
      id: 'c1',
      userId: 'u1',
      textHash: 'hash',
      status: 'done',
      resolvedAt: new Date(),
    });

    const result = await service.updateCommitment('u1', 'c1', 'done');

    expect(prisma.commitment.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { status: 'done', resolvedAt: expect.any(Date), suggestResolve: false },
    });
    // Pins the "PATCH returns a body" contract — the web `request<T>` helper's
    // unconditional `res.json()` rejects on an empty response.
    expect(result).toMatchObject({ id: 'c1', status: 'done' });
    expect(result).not.toHaveProperty('userId');
    expect(result).not.toHaveProperty('textHash');
  });

  it('sets resolvedAt and clears suggestResolve when dismissing, and returns the updated row', async () => {
    const { service, prisma } = makeService();
    prisma.commitment.findUnique.mockResolvedValue({ id: 'c1', userId: 'u1' });
    prisma.commitment.update.mockResolvedValue({
      id: 'c1',
      userId: 'u1',
      textHash: 'hash',
      status: 'dismissed',
      resolvedAt: new Date(),
    });

    const result = await service.updateCommitment('u1', 'c1', 'dismissed');

    expect(prisma.commitment.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { status: 'dismissed', resolvedAt: expect.any(Date), suggestResolve: false },
    });
    expect(result).toMatchObject({ id: 'c1', status: 'dismissed' });
  });

  it('nulls resolvedAt and clears suggestResolve when reopening, and returns the updated row', async () => {
    const { service, prisma } = makeService();
    prisma.commitment.findUnique.mockResolvedValue({ id: 'c1', userId: 'u1' });
    prisma.commitment.update.mockResolvedValue({
      id: 'c1',
      userId: 'u1',
      textHash: 'hash',
      status: 'open',
      resolvedAt: null,
    });

    const result = await service.updateCommitment('u1', 'c1', 'open');

    expect(prisma.commitment.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { status: 'open', resolvedAt: null, suggestResolve: false },
    });
    expect(result).toMatchObject({ id: 'c1', status: 'open' });
  });

  it('rejects an invalid status value', async () => {
    const { service, prisma } = makeService();

    await expect(service.updateCommitment('u1', 'c1', 'bogus')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.commitment.findUnique).not.toHaveBeenCalled();
  });

  it('rejects transitioning a promoted commitment with ConflictException (stale taskId / re-promotion guard)', async () => {
    const { service, prisma } = makeService();
    prisma.commitment.findUnique.mockResolvedValue({ id: 'c1', userId: 'u1', status: 'promoted', taskId: 'task-1' });

    await expect(service.updateCommitment('u1', 'c1', 'open')).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.commitment.update).not.toHaveBeenCalled();
  });
});

describe('MailService.promoteCommitment', () => {
  function makeService() {
    const prisma = {
      commitment: { findUnique: jest.fn(), update: jest.fn() },
      message: { findFirst: jest.fn() },
      task: { delete: jest.fn() },
    } as unknown as PrismaService;
    const zimbra = {} as ZimbraService;
    const notifications = {} as NotificationsService;
    const tasksService = { create: jest.fn() } as unknown as TasksService;
    const service = new MailService(prisma, makeResolver(zimbra), notifications, tasksService);
    return { service: service as any, prisma: prisma as any, tasksService: tasksService as any };
  }

  const openCommitment = {
    id: 'c1',
    userId: 'u1',
    messageId: 'm1',
    text: 'Send the report',
    dueHint: 'Friday',
    status: 'open',
  };

  it('throws NotFoundException when the commitment does not exist', async () => {
    const { service, prisma } = makeService();
    prisma.commitment.findUnique.mockResolvedValue(null);

    await expect(service.promoteCommitment('u1', 'missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws NotFoundException when the commitment belongs to another user', async () => {
    const { service, prisma } = makeService();
    prisma.commitment.findUnique.mockResolvedValue({ ...openCommitment, userId: 'other-user' });

    await expect(service.promoteCommitment('u1', 'c1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('creates a Task with title/dueHint/linkedMessageId/linkedSubject, then marks the commitment promoted', async () => {
    const { service, prisma, tasksService } = makeService();
    prisma.commitment.findUnique.mockResolvedValue(openCommitment);
    prisma.message.findFirst.mockResolvedValue({ subject: 'Q3 report thread' });
    tasksService.create.mockResolvedValue({ id: 'task-1' });
    prisma.commitment.update.mockResolvedValue({});

    const result = await service.promoteCommitment('u1', 'c1');

    expect(prisma.message.findFirst).toHaveBeenCalledWith({
      where: { id: 'm1', userId: 'u1' },
      select: { subject: true },
    });
    expect(tasksService.create).toHaveBeenCalledWith('u1', {
      title: 'Send the report',
      description: 'Due hint: Friday. Extracted from email.',
      linkedMessageId: 'm1',
      linkedSubject: 'Q3 report thread',
    });
    expect(prisma.commitment.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { status: 'promoted', taskId: 'task-1', resolvedAt: expect.any(Date) },
    });
    expect(result).toEqual({ taskId: 'task-1', task: { id: 'task-1' } });
  });

  it('omits the due-hint prefix and falls back to no linkedSubject when the source message is gone', async () => {
    const { service, prisma, tasksService } = makeService();
    prisma.commitment.findUnique.mockResolvedValue({ ...openCommitment, dueHint: null });
    prisma.message.findFirst.mockResolvedValue(null);
    tasksService.create.mockResolvedValue({ id: 'task-2' });
    prisma.commitment.update.mockResolvedValue({});

    await service.promoteCommitment('u1', 'c1');

    expect(tasksService.create).toHaveBeenCalledWith('u1', {
      title: 'Send the report',
      description: 'Extracted from email.',
      linkedMessageId: 'm1',
      linkedSubject: undefined,
    });
  });

  it('rejects promoting a non-open commitment with ConflictException', async () => {
    const { service, prisma, tasksService } = makeService();
    prisma.commitment.findUnique.mockResolvedValue({ ...openCommitment, status: 'done' });

    await expect(service.promoteCommitment('u1', 'c1')).rejects.toBeInstanceOf(ConflictException);
    expect(tasksService.create).not.toHaveBeenCalled();
    expect(prisma.commitment.update).not.toHaveBeenCalled();
  });

  it('compensates by deleting the just-created Task when the commitment update fails, then rethrows (saga)', async () => {
    const { service, prisma, tasksService } = makeService();
    prisma.commitment.findUnique.mockResolvedValue(openCommitment);
    prisma.message.findFirst.mockResolvedValue({ subject: 'Q3 report thread' });
    tasksService.create.mockResolvedValue({ id: 'task-1' });
    const dbError = new Error('connection dropped');
    prisma.commitment.update.mockRejectedValue(dbError);
    prisma.task.delete.mockResolvedValue({});

    await expect(service.promoteCommitment('u1', 'c1')).rejects.toBe(dbError);

    expect(prisma.task.delete).toHaveBeenCalledWith({ where: { id: 'task-1' } });
  });

  it('swallows a failed compensation delete but still surfaces the original error', async () => {
    const { service, prisma, tasksService } = makeService();
    prisma.commitment.findUnique.mockResolvedValue(openCommitment);
    prisma.message.findFirst.mockResolvedValue({ subject: 'Q3 report thread' });
    tasksService.create.mockResolvedValue({ id: 'task-1' });
    const dbError = new Error('connection dropped');
    prisma.commitment.update.mockRejectedValue(dbError);
    prisma.task.delete.mockRejectedValue(new Error('task already gone'));

    await expect(service.promoteCommitment('u1', 'c1')).rejects.toBe(dbError);
    expect(prisma.task.delete).toHaveBeenCalledWith({ where: { id: 'task-1' } });
  });

  it('merges overrides into the create payload — an explicit title wins over the commitment text, while an empty overrides object preserves the derived defaults', async () => {
    const { service, prisma, tasksService } = makeService();
    prisma.commitment.findUnique.mockResolvedValue(openCommitment);
    prisma.message.findFirst.mockResolvedValue({ subject: 'Q3 report thread' });
    tasksService.create.mockResolvedValue({ id: 'task-3' });
    prisma.commitment.update.mockResolvedValue({});

    await service.promoteCommitment('u1', 'c1', {
      title: 'Custom title',
      description: 'Custom description',
      dueDate: '2026-09-10',
      priority: 'HIGH',
    });

    expect(tasksService.create).toHaveBeenCalledWith('u1', {
      title: 'Custom title',
      description: 'Custom description',
      dueDate: '2026-09-10',
      priority: 'HIGH',
      linkedMessageId: 'm1',
      linkedSubject: 'Q3 report thread',
    });

    tasksService.create.mockClear();

    await service.promoteCommitment('u1', 'c1', {});

    expect(tasksService.create).toHaveBeenCalledWith('u1', {
      title: 'Send the report',
      description: 'Due hint: Friday. Extracted from email.',
      dueDate: undefined,
      priority: undefined,
      linkedMessageId: 'm1',
      linkedSubject: 'Q3 report thread',
    });
  });
});

describe('MailService.getMessage attachment classification', () => {
  const user = {
    id: 'u1',
    email: 'u@example.com',
    zimbraHost: 'mail.example.com',
    authToken: 'tok',
    csrfToken: null,
    provider: 'zimbra',
    tokenExpiry: new Date(Date.now() + 60_000),
  };

  function makeService() {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(user) },
      message: {
        findFirst: jest.fn(),
        update: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'm1', zimbraId: 'z1', ...data })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      folder: { findFirst: jest.fn() },
    } as unknown as PrismaService;
    const zimbra = {
      getMessage: jest.fn(),
      downloadAttachmentBuffer: jest.fn().mockResolvedValue({
        data: Buffer.from('gif'),
        contentType: 'image/gif',
      }),
    } as unknown as ZimbraService;
    const notifications = {} as NotificationsService;
    const tasksService = {} as unknown as TasksService;
    const service = new MailService(prisma, makeResolver(zimbra), notifications, tasksService);
    return { service, prisma: prisma as any, zimbra: zimbra as any };
  }

  const cachedRow = { id: 'm1', zimbraId: 'z1', bodyHtml: null, bodyText: null, attachments: null, inlineImages: null };

  it('excludes CID-referenced inline images from the attachment list but keeps real attachments', async () => {
    const { service, prisma, zimbra } = makeService();
    prisma.message.findFirst.mockResolvedValue(cachedRow);
    zimbra.getMessage.mockResolvedValue(mapZimbraMessage({
      id: 'z1', l: '2', su: 'hi', d: Date.now(), f: '', e: [],
      mp: [
        { part: '1', ct: 'text/html', body: true, content: '<p>hi <img src="cid:sig@x"></p>' },
        { part: '2', ct: 'image/gif', filename: 'inline.gif', ci: '<sig@x>', s: 1234 },
        { part: '3', ct: 'application/pdf', filename: 'report.pdf', s: 99 },
      ],
    } as any));

    const result = await service.getMessage('u1', 'm1');

    expect(result.attachments).toEqual([
      { id: '3', filename: 'report.pdf', mimeType: 'application/pdf', size: 99 },
    ]);
    expect(result.hasAttachments).toBe(true);
    // The inline image is still collected for body rendering
    expect(result.inlineImages).toEqual([{ cid: 'sig@x', partId: '2', mimeType: 'image/gif' }]);
  });

  it('reports hasAttachments=false when the only file parts are inline signature images', async () => {
    const { service, prisma, zimbra } = makeService();
    prisma.message.findFirst.mockResolvedValue(cachedRow);
    zimbra.getMessage.mockResolvedValue(mapZimbraMessage({
      id: 'z1', l: '2', su: 'hi', d: Date.now(), f: '', e: [],
      mp: [
        { part: '1', ct: 'text/html', body: true, content: '<p>hi <img src="cid:sig@x"></p>' },
        { part: '2', ct: 'image/gif', filename: 'inline.gif', ci: '<sig@x>', s: 1234 },
      ],
    } as any));

    const result = await service.getMessage('u1', 'm1');

    expect(result.attachments).toEqual([]);
    expect(result.hasAttachments).toBe(false);
  });
});

describe('MailService.getConversation back-fill batching', () => {
  const user = {
    id: 'u1',
    email: 'u@example.com',
    zimbraHost: 'mail.example.com',
    authToken: 'tok',
    csrfToken: null,
    provider: 'zimbra',
    tokenExpiry: new Date(Date.now() + 60_000),
  };

  it('inserts missing thread messages with one batched createMany instead of a per-message upsert loop', async () => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(user) },
      message: {
        findFirst: jest.fn().mockResolvedValue({ id: 'm1', conversationId: 'c1' }),
        findMany: jest
          .fn()
          // 1st call: existing zimbraIds in this conversation
          .mockResolvedValueOnce([{ zimbraId: 'z1' }])
          // 2nd call: final ordered thread listing
          .mockResolvedValueOnce([{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }]),
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
        upsert: jest.fn(),
      },
      folder: {
        findMany: jest.fn().mockResolvedValue([{ id: 'f-inbox', zimbraId: '2' }]),
      },
    } as unknown as PrismaService;
    const zimbra = {
      searchMessages: jest.fn().mockResolvedValue({
        messages: [
          { id: 'z1', l: '2', su: 's', d: 1, f: '', e: [] }, // already synced — skipped
          { id: 'z2', l: '2', su: 's', d: 2, f: 'u', e: [{ t: 'f', a: 'a@x', d: 'A' }] },
          { id: 'z3', l: '2', su: 's', d: 3, f: '', e: [] },
          { id: 'z4', l: '999', su: 's', d: 4, f: '', e: [] }, // folder not synced — skipped
        ].map((m) => mapZimbraMessage(m as any)),
      }),
    } as unknown as ZimbraService;
    const service = new MailService(prisma, makeResolver(zimbra), {} as NotificationsService, {} as TasksService);

    const result = await service.getConversation('u1', 'm1');

    expect((prisma as any).message.upsert).not.toHaveBeenCalled();
    expect((prisma as any).message.createMany).toHaveBeenCalledTimes(1);
    const arg = (prisma as any).message.createMany.mock.calls[0][0];
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data).toHaveLength(2);
    expect(arg.data.map((r: any) => r.zimbraId)).toEqual(['z2', 'z3']);
    expect(arg.data[0]).toMatchObject({
      userId: 'u1',
      folderId: 'f-inbox',
      conversationId: 'c1',
      fromEmail: 'a@x',
      isRead: false,
    });
    expect(result.messages).toHaveLength(3);
  });

  it('skips the batch write entirely when every thread message is already synced', async () => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(user) },
      message: {
        findFirst: jest.fn().mockResolvedValue({ id: 'm1', conversationId: 'c1' }),
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ zimbraId: 'z1' }])
          .mockResolvedValueOnce([{ id: 'm1' }]),
        createMany: jest.fn(),
        upsert: jest.fn(),
      },
      folder: { findMany: jest.fn().mockResolvedValue([{ id: 'f-inbox', zimbraId: '2' }]) },
    } as unknown as PrismaService;
    const zimbra = {
      searchMessages: jest.fn().mockResolvedValue({
        messages: [mapZimbraMessage({ id: 'z1', l: '2', su: 's', d: 1, f: '', e: [] } as any)],
      }),
    } as unknown as ZimbraService;
    const service = new MailService(prisma, makeResolver(zimbra), {} as NotificationsService, {} as TasksService);

    await service.getConversation('u1', 'm1');

    expect((prisma as any).message.createMany).not.toHaveBeenCalled();
  });

  it('does NOT run the Zimbra conv: back-fill for a non-Zimbra (EWS) provider, but still returns the local group', async () => {
    const ewsUser = { ...user, provider: 'ews' };
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(ewsUser) },
      message: {
        findFirst: jest.fn().mockResolvedValue({ id: 'm1', conversationId: 'Budget planning' }),
        // Only the final ordered listing runs — the back-fill's own findMany is
        // inside the (skipped) zimbra branch.
        findMany: jest.fn().mockResolvedValue([{ id: 'm1' }, { id: 'm2' }]),
        createMany: jest.fn(),
        upsert: jest.fn(),
      },
      folder: { findMany: jest.fn() },
    } as unknown as PrismaService;
    // If the gate leaked, this malformed `conv:<topic>` query would hit Exchange.
    const provider = { searchMessages: jest.fn() } as unknown as ZimbraService;
    const service = new MailService(prisma, makeResolver(provider), {} as NotificationsService, {} as TasksService);

    const result = await service.getConversation('u1', 'm1');

    expect((provider as any).searchMessages).not.toHaveBeenCalled();
    expect((prisma as any).folder.findMany).not.toHaveBeenCalled();
    expect((prisma as any).message.createMany).not.toHaveBeenCalled();
    expect(result.messages).toHaveLength(2);
  });
});

describe('MailService.getMessage embed budget (async image embedding)', () => {
  const user = {
    id: 'u1',
    email: 'u@example.com',
    zimbraHost: 'mail.example.com',
    authToken: 'tok',
    csrfToken: null,
    provider: 'zimbra',
    tokenExpiry: new Date(Date.now() + 60_000),
  };

  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  function makeService() {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(user) },
      message: {
        findFirst: jest.fn(),
        update: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'm1', zimbraId: 'z1', ...data })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      folder: { findFirst: jest.fn() },
    } as unknown as PrismaService;
    const zimbra = {
      getMessage: jest.fn(),
      downloadAttachmentBuffer: jest.fn(),
    } as unknown as ZimbraService;
    const service = new MailService(prisma, makeResolver(zimbra), {} as NotificationsService, {} as TasksService);
    return { service, prisma: prisma as any, zimbra: zimbra as any };
  }

  const zimbraMsg = mapZimbraMessage({
    id: 'z1', l: '2', su: 'hi', d: Date.now(), f: '', e: [],
    mp: [
      { part: '1', ct: 'text/html', body: true, content: '<p>hi <img src="cid:sig@x"></p>' },
      { part: '2', ct: 'image/gif', filename: 'inline.gif', ci: '<sig@x>', s: 1234 },
    ],
  } as any);
  const cachedRow = { id: 'm1', zimbraId: 'z1', bodyHtml: null, bodyText: null, attachments: null, inlineImages: null };

  afterEach(() => {
    delete process.env.EMBED_BUDGET_MS;
  });

  it('returns the body immediately with embedPending=true when embedding exceeds the budget, stripping unresolved cid refs from the response', async () => {
    process.env.EMBED_BUDGET_MS = '25';
    const { service, prisma, zimbra } = makeService();
    prisma.message.findFirst.mockResolvedValue(cachedRow);
    zimbra.getMessage.mockResolvedValue(zimbraMsg);
    const dl = deferred<{ data: Buffer; contentType: string }>();
    zimbra.downloadAttachmentBuffer.mockReturnValue(dl.promise);

    const result = await service.getMessage('u1', 'm1');

    expect(result.embedPending).toBe(true);
    // Response body must not contain broken cid: image refs
    expect(result.bodyHtml).not.toContain('cid:');
    // The DB keeps the raw (cid-bearing) body so the cache guard keeps refusing it as final
    expect(prisma.message.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ bodyHtml: expect.stringContaining('cid:') }) }),
    );

    // Background embed finishes → cache warmed with the embedded body
    dl.resolve({ data: Buffer.from('gif'), contentType: 'image/gif' });
    await new Promise((r) => setTimeout(r, 10));
    expect(prisma.message.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { bodyHtml: expect.stringContaining('data:image/gif;base64') } }),
    );
  });

  it('does not re-fetch from Zimbra while a background embed is in flight — serves the cached raw body with embedPending', async () => {
    process.env.EMBED_BUDGET_MS = '25';
    const { service, prisma, zimbra } = makeService();
    prisma.message.findFirst.mockResolvedValue(cachedRow);
    zimbra.getMessage.mockResolvedValue(zimbraMsg);
    const dl = deferred<{ data: Buffer; contentType: string }>();
    zimbra.downloadAttachmentBuffer.mockReturnValue(dl.promise);

    const first = await service.getMessage('u1', 'm1');
    expect(first.embedPending).toBe(true);
    expect(zimbra.getMessage).toHaveBeenCalledTimes(1);

    // Poll while embed is still running: cached row now holds the raw cid body
    prisma.message.findFirst.mockResolvedValue({
      ...cachedRow,
      bodyHtml: '<p>hi <img src="cid:sig@x"></p>',
      attachments: [],
      inlineImages: [{ cid: 'sig@x', partId: '2', mimeType: 'image/gif' }],
    });
    const second = await service.getMessage('u1', 'm1');

    expect(zimbra.getMessage).toHaveBeenCalledTimes(1); // no duplicate Zimbra fetch
    expect(second.embedPending).toBe(true);
    expect(second.bodyHtml).not.toContain('cid:');

    dl.resolve({ data: Buffer.from('gif'), contentType: 'image/gif' });
    await new Promise((r) => setTimeout(r, 10));

    // Embed done → in-flight cleared; a fully-embedded cached row is served as final
    prisma.message.findFirst.mockResolvedValue({
      ...cachedRow,
      bodyHtml: '<p>hi <img src="data:image/gif;base64,Z2lm"></p>',
      attachments: [],
      inlineImages: [{ cid: 'sig@x', partId: '2', mimeType: 'image/gif' }],
    });
    const third = await service.getMessage('u1', 'm1');
    expect(third.embedPending).toBeUndefined();
    expect(zimbra.getMessage).toHaveBeenCalledTimes(1);
  });

  it('returns the embedded body with no embedPending flag when embedding completes within budget', async () => {
    const { service, prisma, zimbra } = makeService();
    prisma.message.findFirst.mockResolvedValue(cachedRow);
    zimbra.getMessage.mockResolvedValue(zimbraMsg);
    zimbra.downloadAttachmentBuffer.mockResolvedValue({ data: Buffer.from('gif'), contentType: 'image/gif' });

    const result = await service.getMessage('u1', 'm1');

    expect(result.embedPending).toBeUndefined();
    expect(result.bodyHtml).toContain('data:image/gif;base64');
  });

  // Pass 2 of the embed (embedZimbraHostedImages) is the one method with both
  // an interface call and a Zimbra-only extra in it. It resolves BOTH from the
  // user row it is handed — no provider argument — so the branch that checks
  // `user.provider` can never disagree with the provider doing the fetching.
  describe('Zimbra-hosted image URLs (pass 2)', () => {
    const hostedMsg = (html: string) =>
      mapZimbraMessage({
        id: 'z1', l: '2', su: 'hi', d: Date.now(), f: '', e: [],
        mp: [{ part: '1', ct: 'text/html', body: true, content: html }],
      } as any);

    it('embeds an id/part URL through the resolved provider', async () => {
      const { service, prisma, zimbra } = makeService();
      prisma.message.findFirst.mockResolvedValue(cachedRow);
      zimbra.getMessage.mockResolvedValue(
        hostedMsg('<p><img src="https://mail.example.com/service/home/~/?id=z9&part=3"></p>'),
      );
      zimbra.downloadAttachmentBuffer.mockResolvedValue({ data: Buffer.from('gif'), contentType: 'image/gif' });

      const result = await service.getMessage('u1', 'm1');

      expect(zimbra.downloadAttachmentBuffer).toHaveBeenCalledWith(
        { host: 'mail.example.com', email: 'u@example.com', authToken: 'tok', csrfToken: undefined },
        'z9',
        '3',
      );
      expect(result.bodyHtml).toContain(`data:image/gif;base64,${Buffer.from('gif').toString('base64')}`);
    });

    it('embeds a path-based URL through the Zimbra-only extra', async () => {
      const { service, prisma, zimbra } = makeService();
      zimbra.downloadZimbraPath = jest.fn().mockResolvedValue({
        data: Buffer.from('png'), contentType: 'image/png',
      });
      prisma.message.findFirst.mockResolvedValue(cachedRow);
      zimbra.getMessage.mockResolvedValue(
        hostedMsg('<p><img src="https://mail.example.com/home/bruce/Briefcase/logo.png"></p>'),
      );

      const result = await service.getMessage('u1', 'm1');

      expect(zimbra.downloadZimbraPath).toHaveBeenCalledWith(
        'mail.example.com', 'tok', '/home/bruce/Briefcase/logo.png',
      );
      expect(zimbra.downloadAttachmentBuffer).not.toHaveBeenCalled();
      expect(result.bodyHtml).toContain(`data:image/png;base64,${Buffer.from('png').toString('base64')}`);
    });

    it('leaves a non-image response at its original URL', async () => {
      const { service, prisma, zimbra } = makeService();
      zimbra.downloadZimbraPath = jest.fn().mockResolvedValue({
        data: Buffer.from('%PDF'), contentType: 'application/pdf',
      });
      prisma.message.findFirst.mockResolvedValue(cachedRow);
      zimbra.getMessage.mockResolvedValue(
        hostedMsg('<p><img src="https://mail.example.com/home/bruce/Briefcase/report.pdf"></p>'),
      );

      const result = await service.getMessage('u1', 'm1');

      expect(result.bodyHtml).toContain('src="https://mail.example.com/home/bruce/Briefcase/report.pdf"');
      expect(result.bodyHtml).not.toContain('base64');
    });
  });
});

describe('MailService.getDefaultSignatureHtml', () => {
  const user = {
    id: 'u1',
    zimbraHost: 'mail.example.com',
    authToken: 'tok',
    csrfToken: 'csrf',
    provider: 'zimbra',
    tokenExpiry: new Date(Date.now() + 60_000),
  };

  function makeService() {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(user) },
    } as unknown as PrismaService;
    const zimbra = {
      getPrefs: jest.fn().mockResolvedValue({}),
      getIdentities: jest.fn().mockResolvedValue([]),
      getSignatures: jest.fn().mockResolvedValue([]),
    } as unknown as ZimbraService;
    const service = new MailService(
      prisma,
      makeResolver(zimbra),
      {} as NotificationsService,
      {} as TasksService,
    );
    return { service, zimbra: zimbra as any };
  }

  const sigs = [
    { id: 's1', name: 'First', contentHtml: '<p>First sig</p>', contentText: 'First sig' },
    { id: 's2', name: 'Default', contentHtml: '<p>Bruce — RISA</p>', contentText: 'Bruce — RISA' },
  ];

  it('uses the identity default signature id when configured', async () => {
    const { service, zimbra } = makeService();
    zimbra.getSignatures.mockResolvedValue(sigs);
    zimbra.getIdentities.mockResolvedValue([
      { id: 'i1', name: 'DEFAULT', attrs: { zimbraPrefDefaultSignatureId: 's2' } },
    ]);

    await expect(service.getDefaultSignatureHtml('u1')).resolves.toBe('<p>Bruce — RISA</p>');
  });

  it('falls back to the prefs default signature id when the identity has none', async () => {
    const { service, zimbra } = makeService();
    zimbra.getSignatures.mockResolvedValue(sigs);
    zimbra.getPrefs.mockResolvedValue({ zimbraPrefDefaultSignatureId: 's2' });

    await expect(service.getDefaultSignatureHtml('u1')).resolves.toBe('<p>Bruce — RISA</p>');
  });

  it('falls back to the first signature when no default is configured', async () => {
    const { service, zimbra } = makeService();
    zimbra.getSignatures.mockResolvedValue(sigs);

    await expect(service.getDefaultSignatureHtml('u1')).resolves.toBe('<p>First sig</p>');
  });

  it('falls back to the first signature when the configured id no longer exists', async () => {
    const { service, zimbra } = makeService();
    zimbra.getSignatures.mockResolvedValue(sigs);
    zimbra.getIdentities.mockResolvedValue([
      { id: 'i1', name: 'DEFAULT', attrs: { zimbraPrefDefaultSignatureId: 'gone' } },
    ]);

    await expect(service.getDefaultSignatureHtml('u1')).resolves.toBe('<p>First sig</p>');
  });

  it('converts a text-only signature to HTML paragraphs', async () => {
    const { service, zimbra } = makeService();
    zimbra.getSignatures.mockResolvedValue([
      { id: 's1', name: 'Plain', contentHtml: '', contentText: 'Bruce\n\nRISA' },
    ]);

    await expect(service.getDefaultSignatureHtml('u1')).resolves.toBe(
      '<p>Bruce</p><p><br></p><p>RISA</p>',
    );
  });

  it('returns an empty string when the user has no signatures', async () => {
    const { service } = makeService();

    await expect(service.getDefaultSignatureHtml('u1')).resolves.toBe('');
  });

  it('returns an empty string instead of throwing when Zimbra errors', async () => {
    const { service, zimbra } = makeService();
    zimbra.getSignatures.mockRejectedValue(new Error('zimbra down'));

    await expect(service.getDefaultSignatureHtml('u1')).resolves.toBe('');
  });

  it('inlines /home/ Briefcase images as data URIs (parity with compose GET /settings)', async () => {
    const { service, zimbra } = makeService();
    zimbra.getSignatures.mockResolvedValue([
      {
        id: 's1',
        name: 'First',
        contentHtml: '<p>Bruce</p><img src="/home/bruce@risa.gov.rw/Briefcase/logo.gif">',
        contentText: 'Bruce',
      },
    ]);
    zimbra.downloadZimbraPath = jest.fn().mockResolvedValue({
      data: Buffer.from('gifdata'),
      contentType: 'image/gif',
    });

    const html = await service.getDefaultSignatureHtml('u1');

    expect(html).toContain('src="data:image/gif;base64,');
    expect(html).toContain('data-zimbra-src="/home/bruce@risa.gov.rw/Briefcase/logo.gif"');
    expect(html).not.toMatch(/<img src="\/home\//);
  });
});

describe('MailService.sendMessage body formatting', () => {
  const user = {
    id: 'u1',
    email: 'bruce@risa.gov.rw',
    zimbraHost: 'mail.example.com',
    authToken: 'tok',
    csrfToken: 'csrf',
    provider: 'zimbra',
    tokenExpiry: new Date(Date.now() + 60_000),
  };

  function makeService() {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(user) },
      message: { findFirst: jest.fn().mockResolvedValue(null) },
      folder: { findFirst: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const zimbra = {
      sendMessage: jest.fn().mockResolvedValue({ id: null, conversationId: null }),
      getPrefs: jest.fn().mockResolvedValue({}),
      getIdentities: jest.fn().mockResolvedValue([]),
      getSignatures: jest.fn().mockResolvedValue([
        { id: 's1', name: 'Default', contentHtml: '<p>Bruce — RISA</p>', contentText: 'Bruce — RISA' },
      ]),
    } as unknown as ZimbraService;
    const service = new MailService(
      prisma,
      makeResolver(zimbra),
      {} as NotificationsService,
      {} as TasksService,
    );
    return { service, zimbra: zimbra as any };
  }

  it('converts a markdown body and appends the default signature when bodyFormat is markdown', async () => {
    const { service, zimbra } = makeService();

    await service.sendMessage('u1', {
      to: ['a@b.rw'],
      subject: 'S',
      body: 'Hello\n\n- a\n- b',
      bodyFormat: 'markdown',
    });

    expect(zimbra.sendMessage).toHaveBeenCalledWith(
      { host: 'mail.example.com', email: 'bruce@risa.gov.rw', authToken: 'tok', csrfToken: 'csrf' },
      expect.objectContaining({
        body: '<p>Hello</p><ul><li>a</li><li>b</li></ul><p><br></p><div data-sig="1"><p>Bruce — RISA</p></div>',
      }),
      [],
      [],
      [],
    );
  });

  it('sends the markdown-converted body without a signature block when the user has none', async () => {
    const { service, zimbra } = makeService();
    zimbra.getSignatures.mockResolvedValue([]);

    await service.sendMessage('u1', {
      to: ['a@b.rw'],
      subject: 'S',
      body: 'Hello',
      bodyFormat: 'markdown',
    });

    expect(zimbra.sendMessage.mock.calls[0][1].body).toBe('<p>Hello</p>');
  });

  it('leaves HTML bodies untouched when bodyFormat is not set', async () => {
    const { service, zimbra } = makeService();

    await service.sendMessage('u1', {
      to: ['a@b.rw'],
      subject: 'S',
      body: '<p>already html</p>',
    });

    expect(zimbra.sendMessage.mock.calls[0][1].body).toBe('<p>already html</p>');
    expect(zimbra.getSignatures).not.toHaveBeenCalled();
  });
});

describe('MailService.saveDraft body formatting', () => {
  const user = {
    id: 'u1',
    zimbraHost: 'mail.example.com',
    authToken: 'tok',
    csrfToken: 'csrf',
    provider: 'zimbra',
    tokenExpiry: new Date(Date.now() + 60_000),
  };

  function makeService() {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(user) },
    } as unknown as PrismaService;
    const zimbra = {
      saveDraft: jest.fn().mockResolvedValue('z9'),
      getPrefs: jest.fn().mockResolvedValue({}),
      getIdentities: jest.fn().mockResolvedValue([]),
      getSignatures: jest.fn().mockResolvedValue([
        { id: 's1', name: 'Default', contentHtml: '<p>Bruce — RISA</p>', contentText: 'Bruce — RISA' },
      ]),
    } as unknown as ZimbraService;
    const service = new MailService(
      prisma,
      makeResolver(zimbra),
      {} as NotificationsService,
      {} as TasksService,
    );
    return { service, zimbra: zimbra as any };
  }

  it('converts a markdown body and appends the default signature when bodyFormat is markdown', async () => {
    const { service, zimbra } = makeService();

    await service.saveDraft('u1', {
      to: ['a@b.rw'],
      subject: 'S',
      body: 'Hello\n\n- a\n- b',
      bodyFormat: 'markdown',
    });

    expect(zimbra.saveDraft.mock.calls[0][1].body).toBe(
      '<p>Hello</p><ul><li>a</li><li>b</li></ul><p><br></p><div data-sig="1"><p>Bruce — RISA</p></div>',
    );
  });

  it('leaves the body untouched when bodyFormat is not set', async () => {
    const { service, zimbra } = makeService();

    await service.saveDraft('u1', { to: ['a@b.rw'], subject: 'S', body: '<p>html</p>' });

    expect(zimbra.saveDraft.mock.calls[0][1].body).toBe('<p>html</p>');
    expect(zimbra.getSignatures).not.toHaveBeenCalled();
  });
});

describe('MailService.searchStructured', () => {
  const user = {
    id: 'u1',
    email: 'u@example.com',
    zimbraHost: 'mail.example.com',
    authToken: 'tok',
    csrfToken: null,
    provider: 'zimbra',
    tokenExpiry: new Date(Date.now() + 60_000),
  };

  function makeService() {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(user) },
      folder: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
      message: { upsert: jest.fn() },
      // persistSearchResults batches its writes; emulate the batch faithfully
      // so the mocked upserts still resolve in order.
      $transaction: jest.fn((ops: any[]) => Promise.all(ops)),
    } as unknown as PrismaService;
    const zimbra = {
      searchStructured: jest.fn(),
    } as unknown as ZimbraService;
    const service = new MailService(prisma, makeResolver(zimbra), {} as NotificationsService, {} as TasksService);
    return { service, prisma: prisma as any, zimbra: zimbra as any };
  }

  it('rejects an all-empty filter with 400, before touching the user or any provider', async () => {
    const { service, prisma, zimbra } = makeService();

    await expect(service.searchStructured('u1', {}, 50, 0)).rejects.toThrow(BadRequestException);
    await expect(service.searchStructured('u1', {}, 50, 0)).rejects.toThrow(/at least one filter/i);

    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(zimbra.searchStructured).not.toHaveBeenCalled();
  });

  it('rejects a folderId the user does not own with 404, without calling the provider', async () => {
    const { service, prisma, zimbra } = makeService();
    prisma.folder.findFirst.mockResolvedValue(null);

    await expect(service.searchStructured('u1', { folderId: 'not-mine' }, 50, 0)).rejects.toThrow(NotFoundException);

    // The web sends the DB folder id (same contract as getMessages) — the
    // lookup must be by DB id, not by provider zimbraId.
    expect(prisma.folder.findFirst).toHaveBeenCalledWith({ where: { userId: 'u1', id: 'not-mine' } });
    expect(zimbra.searchStructured).not.toHaveBeenCalled();
  });

  it('resolves filter.folderId from the DB id to the provider zimbraId before calling the provider (C1)', async () => {
    const { service, prisma, zimbra } = makeService();
    // folderId DB-id → zimbraId resolution
    prisma.folder.findFirst
      .mockResolvedValueOnce({ id: 'inbox-id', zimbraId: 'zf-2', userId: 'u1', path: '/Inbox' });
    // persistSearchResults resolves folders for the whole page in one read
    prisma.folder.findMany.mockResolvedValue([{ id: 'inbox-id', zimbraId: 'zf-2' }]);
    const providerMessage = {
      id: 'z1', conversationId: 'c1', folderId: 'zf-2',
      subject: 'Budget', snippet: 'Q3 numbers',
      from: { email: 'a@b.rw', name: 'A' }, to: [{ email: 'u@example.com' }], cc: [], bcc: [],
      receivedAt: new Date('2026-09-01'), size: 100,
      isRead: true, isFlagged: false, hasAttachments: false, isDraft: false, tags: [],
    };
    zimbra.searchStructured.mockResolvedValue({ messages: [providerMessage], total: 1, more: false });
    prisma.message.upsert.mockResolvedValue({ id: 'm1', zimbraId: 'z1', subject: 'Budget' });

    // The web sends the DB folder id ('inbox-id'), not the provider id.
    const filter = { subject: 'Budget', folderId: 'inbox-id' };
    const result = await service.searchStructured('u1', filter, 25, 5);

    expect(prisma.folder.findFirst).toHaveBeenCalledWith({ where: { userId: 'u1', id: 'inbox-id' } });
    // The provider must receive the resolved zimbraId, never the raw DB id.
    expect(zimbra.searchStructured).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ subject: 'Budget', folderId: 'zf-2' }),
      25,
      5,
    );
    expect(result).toEqual({
      messages: [{ id: 'm1', zimbraId: 'z1', subject: 'Budget' }],
      total: 1,
      offset: 5,
      limit: 25,
      hasMore: false,
    });
  });

  it('rejects a malformed dateFrom with 400, without calling the provider (I2)', async () => {
    const { service, prisma, zimbra } = makeService();

    await expect(
      service.searchStructured('u1', { dateFrom: '2026 OR from:x' }, 50, 0),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.folder.findFirst).not.toHaveBeenCalled();
    expect(zimbra.searchStructured).not.toHaveBeenCalled();
  });

  it('rejects a malformed dateTo with 400, without calling the provider (I2)', async () => {
    const { service, prisma, zimbra } = makeService();

    await expect(
      service.searchStructured('u1', { subject: 'x', dateTo: 'not-a-date' }, 50, 0),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.folder.findFirst).not.toHaveBeenCalled();
    expect(zimbra.searchStructured).not.toHaveBeenCalled();
  });

  it('accepts a well-formed YYYY-MM-DD dateFrom/dateTo and forwards it to the provider', async () => {
    const { service, prisma, zimbra } = makeService();
    zimbra.searchStructured.mockResolvedValue({ messages: [], total: 0, more: false });

    const filter = { subject: 'Budget', dateFrom: '2026-01-01', dateTo: '2026-09-10' };
    await service.searchStructured('u1', filter, 25, 0);

    expect(zimbra.searchStructured).toHaveBeenCalledWith(expect.anything(), filter, 25, 0);
  });
});


describe('MailService search-result persistence (round-trip batching)', () => {
  const user = {
    id: 'u1', email: 'u@example.com', zimbraHost: 'mail.example.com',
    authToken: 'tok', csrfToken: null, provider: 'zimbra',
    tokenExpiry: new Date(Date.now() + 60_000),
  };

  const providerMessage = (id: string, folderId: string, subject: string) => ({
    id, conversationId: 'c1', folderId, subject, snippet: 's',
    from: { email: 'a@b.rw', name: 'A' }, to: [{ email: 'u@example.com' }], cc: [], bcc: [],
    receivedAt: new Date('2026-09-01'), size: 10,
    isRead: false, isFlagged: false, hasAttachments: false, isDraft: false, tags: [],
  });

  function makeService(messages: any[]) {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(user) },
      folder: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([
          { id: 'f-inbox', zimbraId: '2' },
          { id: 'f-sent', zimbraId: '5' },
        ]),
      },
      message: {
        upsert: jest.fn((args: any) => Promise.resolve({
          id: 'db-' + args.where.userId_zimbraId.zimbraId,
          zimbraId: args.where.userId_zimbraId.zimbraId,
        })),
      },
      $transaction: jest.fn((ops: any[]) => Promise.all(ops)),
    } as unknown as PrismaService;
    const zimbra = {
      searchMessages: jest.fn().mockResolvedValue({ messages, total: messages.length, more: false }),
    } as unknown as ZimbraService;
    const service = new MailService(prisma, makeResolver(zimbra), {} as NotificationsService, {} as TasksService);
    return { service, prisma: prisma as any, zimbra: zimbra as any };
  }

  it('reads folders once and batches every write into a single transaction', async () => {
    const messages = [
      providerMessage('z1', '2', 'one'),
      providerMessage('z2', '5', 'two'),
      providerMessage('z3', '2', 'three'),
    ];
    const { service, prisma } = makeService(messages);

    const out = await service.searchMessages('u1', 'budget', 50, 0);

    // ONE folder read for the whole page — never one per message (the old
    // shape cost ~2 sequential round-trips per result).
    expect(prisma.folder.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.folder.findFirst).not.toHaveBeenCalled();
    // ONE batched write for the whole page.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(3);
    // Provider order preserved.
    expect(out.messages.map((m: any) => m.zimbraId)).toEqual(['z1', 'z2', 'z3']);
    expect(out.total).toBe(3);
  });

  it('never selects message bodies into a search page', async () => {
    const { service, prisma } = makeService([providerMessage('z1', '2', 'one')]);

    await service.searchMessages('u1', 'budget', 50, 0);

    const selected = prisma.message.upsert.mock.calls[0][0].select;
    expect(selected).toBeDefined();
    expect(selected.bodyHtml).toBeUndefined();
    expect(selected.bodyText).toBeUndefined();
    expect(selected.subject).toBe(true);
  });

  it('degrades a message whose folder is not synced to an ephemeral row instead of dropping it', async () => {
    const { service, prisma } = makeService([
      providerMessage('z1', '2', 'synced'),
      providerMessage('z9', '999', 'unsynced-folder'),
    ]);

    const out = await service.searchMessages('u1', 'budget', 50, 0);

    expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(1); // only the synced one is written
    expect(out.messages).toHaveLength(2);                          // but both are returned
    expect(out.messages[1]).toMatchObject({ id: 'z9', zimbraId: 'z9' });
  });

  it('costs zero DB round-trips when the provider returns no results', async () => {
    const { service, prisma } = makeService([]);

    const out = await service.searchMessages('u1', 'nothing-matches', 50, 0);

    expect(prisma.folder.findMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(out).toMatchObject({ messages: [], total: 0, hasMore: false });
  });
});

describe('MailService markNotSpam', () => {
  // `provider` is what MailProviderResolver.forUser reads — the DB always
  // carries it, so the fixture has to as well or the resolver rejects the user.
  const user = { id: 'u1', authToken: 'tok', tokenExpiry: new Date(Date.now() + 60_000), provider: 'zimbra' };
  const junk = { id: 'f-junk', zimbraId: 'z-junk', path: '/Junk' };
  const inbox = { id: 'f-inbox', zimbraId: 'z-inbox', path: '/Inbox' };
  const message = { id: 'm1', userId: 'u1', zimbraId: 'z-m1', folderId: 'f-junk', fromEmail: 'sender@evil.com' };

  /** Prisma + provider wiring shared by the cases below. */
  function makeNotSpamService(rules: Array<{ id: string; type: string; address: string }>) {
    const moveMessage = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(user) },
      message: { findFirst: jest.fn().mockResolvedValue(message), update: jest.fn().mockResolvedValue(message) },
      folder: {
        findFirst: jest.fn(({ where }: any) =>
          Promise.resolve(where.id === 'f-junk' ? junk : where.path === '/Inbox' ? inbox : null),
        ),
      },
      senderRule: {
        findMany: jest.fn().mockResolvedValue(rules),
        delete: jest.fn().mockResolvedValue(undefined),
        create: jest.fn().mockResolvedValue(undefined),
      },
    } as unknown as PrismaService;
    const zimbra = { moveMessage } as unknown as ZimbraService;
    const service = new MailService(
      prisma, makeResolver(zimbra), {} as NotificationsService, { create: jest.fn() } as unknown as TasksService,
    );
    return { service, prisma: prisma as any, moveMessage };
  }

  it('moves the message to the Inbox', async () => {
    const { service, prisma, moveMessage } = makeNotSpamService([]);

    await service.markNotSpam('u1', 'm1');

    expect(moveMessage).toHaveBeenCalledWith(expect.anything(), 'z-m1', 'z-inbox');
    expect(prisma.message.update).toHaveBeenCalledWith({
      where: { id: 'm1' }, data: { folderId: 'f-inbox' },
    });
  });

  it('deletes the exact-address BLOCK rule, so the next sync cannot re-file it', async () => {
    // Without this the message is dragged straight back to Junk by
    // enforceSenderRules on the next Inbox sync, and the button looks broken.
    const { service, prisma } = makeNotSpamService([
      { id: 'r1', type: 'BLOCK', address: 'sender@evil.com' },
    ]);

    const result = await service.markNotSpam('u1', 'm1');

    expect(prisma.senderRule.delete).toHaveBeenCalledWith({ where: { id: 'r1' } });
    expect(prisma.senderRule.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ unblocked: true });
  });

  it('keeps a domain-wide BLOCK and allows just this sender instead', async () => {
    // Deleting @evil.com because one message was rescued would unblock the
    // whole domain. ALLOW beats BLOCK in the matcher, so a narrower allow is
    // the intended way to carve out one sender.
    const { service, prisma } = makeNotSpamService([
      { id: 'r1', type: 'BLOCK', address: '@evil.com' },
    ]);

    const result = await service.markNotSpam('u1', 'm1');

    expect(prisma.senderRule.delete).not.toHaveBeenCalled();
    expect(prisma.senderRule.create).toHaveBeenCalledWith({
      data: { userId: 'u1', type: 'ALLOW', address: 'sender@evil.com' },
    });
    expect(result).toMatchObject({ unblocked: true });
  });

  it('removes the exact rule AND allows the sender when a domain block also covers them', async () => {
    const { service, prisma } = makeNotSpamService([
      { id: 'r1', type: 'BLOCK', address: 'sender@evil.com' },
      { id: 'r2', type: 'BLOCK', address: '@evil.com' },
    ]);

    await service.markNotSpam('u1', 'm1');

    expect(prisma.senderRule.delete).toHaveBeenCalledWith({ where: { id: 'r1' } });
    expect(prisma.senderRule.create).toHaveBeenCalledWith({
      data: { userId: 'u1', type: 'ALLOW', address: 'sender@evil.com' },
    });
  });

  it('touches no rules when the sender was never blocked', async () => {
    const { service, prisma } = makeNotSpamService([
      { id: 'r1', type: 'BLOCK', address: 'someone-else@evil.com' },
    ]);

    const result = await service.markNotSpam('u1', 'm1');

    expect(prisma.senderRule.delete).not.toHaveBeenCalled();
    expect(prisma.senderRule.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ unblocked: false });
  });

  it('refuses a message that is not in a spam folder', async () => {
    const { service, prisma, moveMessage } = makeNotSpamService([]);
    prisma.folder.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(where.id === 'f-junk' ? { ...junk, path: '/Archive' } : inbox),
    );

    await expect(service.markNotSpam('u1', 'm1')).rejects.toBeInstanceOf(BadRequestException);
    expect(moveMessage).not.toHaveBeenCalled();
  });
});

describe('MailService new-mail detection', () => {
  const user = { id: 'u1', authToken: 'tok', tokenExpiry: new Date(Date.now() + 60_000), provider: 'zimbra' };

  /** One row of the folders table, as the fake below stores it. */
  interface FolderRow { id: string; zimbraId: string; path: string; unreadCount: number }

  /** The Inbox row a healthy mailbox holds: the one the provider still returns. */
  const liveInbox = (unreadCount: number): FolderRow => ({
    id: 'f-inbox', zimbraId: 'z-inbox', path: '/Inbox', unreadCount,
  });

  interface DetectionOpts {
    /** The unread count the stored Inbox row holds: the baseline the delta is
     *  measured from. Defaults to 2. */
    storedUnread?: number;
    /**
     * The whole folders table for this user, in INSERTION order — which is the
     * order an unordered `findFirst` is most likely to hand back. Defaults to
     * the one live Inbox row.
     */
    folderRows?: FolderRow[];
    /** Override the baseline read — used to exercise a DB failure, or a
     *  mailbox with no stored Inbox row at all. */
    findUnique?: jest.Mock;
    /** Override the conditional baseline advance — used to exercise a DB
     *  failure. */
    updateMany?: jest.Mock;
    /**
     * Stand in for a CONCURRENT sync. Called with the folder table immediately
     * before attempt `attempt`'s compare-and-swap is evaluated, so a test can
     * move the baseline out from under it exactly as another sync would.
     */
    onAttempt?: (attempt: number, rows: FolderRow[]) => void;
    /** The newest unread Inbox message the DB holds, if any. */
    newestUnread?: { fromName?: string | null; fromEmail: string; subject?: string | null } | null;
    /** Override the newest-unread-message read — used to exercise a DB failure. */
    messageFindFirst?: jest.Mock;
  }

  function makeService(fetchedUnread: number, opts: DetectionOpts = {}) {
    const rows: FolderRow[] = opts.folderRows ?? [liveInbox(opts.storedUnread ?? 2)];

    // Which reads and writes ran INSIDE prisma.$transaction, in order. Two
    // orderings matter and neither is visible from the arguments alone: the
    // claim and the notification insert must be in ONE transaction (a crash
    // between them advances the baseline with no row to show for it), and the
    // body lookup must be OUTSIDE it (no extra query work inside a held
    // transaction).
    const trace: string[] = [];
    let txDepth = 0;
    const mark = (what: string) => { trace.push(txDepth > 0 ? `${what}@tx` : what); };

    const createNotification = jest.fn(async (...__args: any[]) => { mark('createNotification'); return {}; });
    const notifications = { createNotification } as unknown as NotificationsService;

    const messageFindFirst = opts.messageFindFirst ?? jest.fn(async () => {
      mark('newMailBody');
      return opts.newestUnread ?? null;
    });

    let attempt = 0;
    const updateMany = opts.updateMany ?? jest.fn(async ({ where, data }: any) => {
      opts.onAttempt?.(attempt, rows);
      attempt += 1;
      mark('claim');
      // A faithful compare-and-swap: it matches only while the row still holds
      // the exact count the claiming sync measured from.
      const row = rows.find((r) => r.id === where.id && r.unreadCount === where.unreadCount);
      if (!row) return { count: 0 };
      row.unreadCount = data.unreadCount;
      return { count: 1 };
    });

    // The baseline read, by the table's ONLY unique key.
    const findUnique = opts.findUnique ?? jest.fn(async ({ where }: any) => {
      const { zimbraId } = where.userId_zimbraId;
      const row = rows.find((r) => r.zimbraId === zimbraId);
      // A COPY, as Prisma's `select` returns — not a live reference into the
      // table, which would let a later write appear to rewrite what was read.
      return row ? { ...row } : null;
    });

    // Present only so a test can prove notifyNewMail does NOT use it. A
    // `path: '/Inbox'` lookup is not unique — the table's only uniqueness is
    // (userId, zimbraId) — so it picks an arbitrary row when two exist.
    const findFirst = jest.fn(async ({ where }: any) => {
      const row = rows.find((r) => r.path === where.path);
      return row ? { ...row } : null;
    });

    const prisma: any = {
      user: { findUnique: jest.fn().mockResolvedValue(user), update: jest.fn() },
      folder: { findUnique, findFirst, updateMany, upsert: jest.fn().mockResolvedValue({ id: 'f-inbox' }) },
      message: { findFirst: messageFindFirst },
    };
    prisma.$transaction = jest.fn(async (fn: any) => {
      txDepth += 1;
      try {
        return await fn(prisma);
      } finally {
        txDepth -= 1;
      }
    });

    const zimbra = {
      getFolders: jest.fn().mockResolvedValue([
        { id: 'z-inbox', name: 'Inbox', path: '/Inbox', kind: 'mail', unreadCount: fetchedUnread, totalCount: 10 },
      ]),
    } as unknown as ZimbraService;
    const service = new MailService(
      prisma as PrismaService, makeResolver(zimbra), notifications,
      { create: jest.fn() } as unknown as TasksService,
    );
    return {
      service,
      createNotification,
      notifications: notifications as any,
      prisma,
      rows,
      trace,
      messageFindFirst,
      updateMany,
      findUnique,
      findFirst,
    };
  }

  it('creates one NEW_MAIL notification when the inbox unread count rises', async () => {
    const { service, createNotification } = makeService(5);

    await service.getFolders('u1');

    expect(createNotification).toHaveBeenCalledTimes(1);
    const [userId, type, title, , actionUrl, metadata] = createNotification.mock.calls[0] as any[];
    expect(userId).toBe('u1');
    expect(type).toBe('NEW_MAIL');
    expect(title).toBe('3 new messages');
    expect(actionUrl).toBe('/mail');
    // Recorded for debugging only: what the delta was measured FROM, what was
    // announced, and the difference. Nothing compares these across rows.
    expect(metadata).toEqual({ baseline: 2, unreadCount: 5, delta: 3 });
  });

  it('says "1 new message" for a single arrival', async () => {
    const { service, createNotification } = makeService(3);
    await service.getFolders('u1');
    expect(createNotification.mock.calls[0][2]).toBe('1 new message');
  });

  it('creates nothing, and writes nothing, when the count is unchanged', async () => {
    const { service, createNotification, updateMany } = makeService(2);
    await service.getFolders('u1');
    expect(createNotification).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('creates nothing, and writes nothing, when the count FALLS — mail read elsewhere is not an arrival', async () => {
    // A fall is not an arrival, and it must not move the baseline either: the
    // upsert loop in getFolders owns that write. notifyNewMail only ever
    // writes the baseline it is claiming.
    const { service, createNotification, updateMany } = makeService(1);
    await service.getFolders('u1');
    expect(createNotification).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('creates nothing, logs nothing, and does not crash, when there is no stored Inbox row yet', async () => {
    // The very first sync a mailbox ever does: there is no baseline to compare
    // against, so there is no arrival to announce and nothing to claim.
    //
    // The WARN assertion is what gives this test teeth. Without it, deleting
    // the `if (!previous) return` guard still passes: `previous.unreadCount`
    // throws straight into notifyNewMail's own try/catch, which also yields no
    // notification and no claim. The absence of a logged warning is the only
    // observable difference between "handled" and "crashed and swallowed".
    const { service, createNotification, updateMany } = makeService(5, {
      findUnique: jest.fn().mockResolvedValue(null),
    });
    const warn = jest.spyOn((service as any).logger, 'warn');

    await expect(service.getFolders('u1')).resolves.toBeDefined();

    expect(createNotification).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads the baseline by the SAME identity the persist loop writes by', async () => {
    // (userId, zimbraId) is the folders table's only unique key, and the
    // upsert loop in getFolders writes by it. Reading by anything else reads a
    // different row from the one that gets written.
    const { service, findUnique, findFirst } = makeService(5);

    await service.getFolders('u1');

    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId_zimbraId: { userId: 'u1', zimbraId: 'z-inbox' } } }),
    );
    // `where: { userId, path: '/Inbox' }` matches more than one row (see the
    // stale-namesake test below) and has no ordering, so it must not be how
    // the baseline is found.
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('still returns the folder list when creating the notification throws', async () => {
    // The folder list is the user's mailbox. An alert failure must never cost it.
    const { service, notifications } = makeService(5);
    notifications.createNotification.mockRejectedValue(new Error('db down'));

    await expect(service.getFolders('u1')).resolves.toBeDefined();
  });

  it('still returns the folder list, and creates no notification, when reading the baseline throws', async () => {
    // The baseline read happens inside notifyNewMail (not getFolders)
    // precisely so a transient DB failure here degrades to "no previous row"
    // instead of breaking folder sync.
    const { service, createNotification } = makeService(
      5, { findUnique: jest.fn().mockRejectedValue(new Error('connection reset')) },
    );

    const result = await service.getFolders('u1');

    expect(result).toBeDefined();
    expect(createNotification).not.toHaveBeenCalled();
  });

  describe('two Inbox rows for one user', () => {
    // `path` is not unique. Nothing prunes folder rows the provider has stopped
    // returning, so one user can hold two rows both stamped '/Inbox': flipping
    // an Institution.provider from zimbra to exchange keeps the same User row
    // (auth upserts on email) while EWS returns different folder ids that also
    // map to '/Inbox'; so does a Demo/local login on a real address, a restored
    // mailbox, and renameFolder, which rewrites `path` to `/${name}`
    // unconditionally.
    //
    // The stale row is never upserted again, so its count is FROZEN. Measuring
    // against it computes a negative delta on every sync forever — no chime, no
    // toast, no row, indefinitely.
    const stale: FolderRow = { id: 'f-stale', zimbraId: 'ews-inbox', path: '/Inbox', unreadCount: 37 };

    it('measures against the row the PROVIDER still returns, not the stale namesake', async () => {
      const { service, createNotification, updateMany, rows, messageFindFirst } = makeService(5, {
        // Insertion order: the stale row came first, which is what an
        // unordered findFirst is most likely to return.
        folderRows: [stale, liveInbox(2)],
      });

      await service.getFolders('u1');

      expect(createNotification).toHaveBeenCalledTimes(1);
      expect(createNotification.mock.calls[0][2]).toBe('3 new messages');
      expect(createNotification.mock.calls[0][5]).toEqual({ baseline: 2, unreadCount: 5, delta: 3 });
      // The claim keys on the id the baseline read returned, so correcting the
      // read moves the claim with it.
      expect(updateMany).toHaveBeenCalledWith({
        where: { id: 'f-inbox', unreadCount: 2 }, data: { unreadCount: 5 },
      });
      // And the body is read from the live folder, not the stale one.
      expect(messageFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'u1', folderId: 'f-inbox', isRead: false } }),
      );
      // The stale row is left exactly as it was: notifyNewMail writes only the
      // baseline it claims, and nothing here prunes.
      expect(rows.find((r) => r.id === 'f-stale')!.unreadCount).toBe(37);
    });

    it('a genuine arrival still notifies when the stale count is far higher', async () => {
      // 37 is the frozen count. Against it every real arrival looks like a
      // fall, which is how this became permanent silence rather than one
      // missed chime.
      const { service, createNotification } = makeService(1, {
        folderRows: [{ ...stale, unreadCount: 37 }, liveInbox(0)],
      });

      await service.getFolders('u1');

      expect(createNotification).toHaveBeenCalledTimes(1);
      expect(createNotification.mock.calls[0][2]).toBe('1 new message');
    });
  });

  describe('dedupe by compare-and-swap on the stored baseline', () => {
    it('claims the transition by advancing the baseline CONDITIONALLY, and only then speaks', async () => {
      // The decision and the write are one operation: whoever moves the stored
      // baseline off the exact value it measured from owns the announcement.
      // The condition is what makes it a claim rather than a plain write, and
      // the ORDER is what makes it a claim rather than an afterthought — an
      // insert that preceded the claim would announce arrivals it did not own.
      const { service, createNotification, updateMany, trace } = makeService(5);

      await service.getFolders('u1');

      expect(updateMany).toHaveBeenCalledWith({
        where: { id: 'f-inbox', unreadCount: 2 },
        data: { unreadCount: 5 },
      });
      expect(createNotification).toHaveBeenCalledTimes(1);
      expect(trace.indexOf('claim@tx')).toBeLessThan(trace.indexOf('createNotification@tx'));
    });

    it('claims and inserts inside ONE transaction, with the body resolved before it opens', async () => {
      // A crash between the claim and the insert used to lose the arrival
      // outright: the baseline had moved, so the next sync saw no delta, and no
      // row existed to show for it. One transaction makes the pair atomic —
      // either the baseline moved AND the row exists, or neither happened.
      //
      // The body lookup stays outside: it is a second query, and holding a
      // transaction open across it on a per-sync path buys nothing.
      const { service, trace, prisma } = makeService(5);

      await service.getFolders('u1');

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(trace).toEqual(['newMailBody', 'claim@tx', 'createNotification@tx']);
    });

    it('creates nothing when a concurrent sync already announced the count this one measured', async () => {
      // Two syncs read the same stored baseline before either wrote. The first
      // to run the conditional update matches the row and announces; the
      // second matches NOTHING, because the baseline it required is gone. It
      // then re-reads, finds the baseline already at (or past) the count it
      // measured, and has nothing left to say.
      const { service, createNotification, findUnique } = makeService(5, {
        onAttempt: (attempt, rows) => { if (attempt === 0) rows[0].unreadCount = 5; },
      });

      await service.getFolders('u1');

      expect(createNotification).not.toHaveBeenCalled();
      // It re-read rather than assuming: a zero means "the baseline moved",
      // not "what I measured has been announced".
      expect(findUnique).toHaveBeenCalledTimes(2);
    });

    it('retries with its OWN, larger delta when the winning sync announced less', async () => {
      // count === 0 means "someone moved that baseline", not "someone
      // announced what I measured". Sync A claims 2->5 and says "3 new" while
      // sync B measured 6, so B's sixth message would appear in no
      // announcement at all. B re-reads, sees 5 — still below the 6 it
      // measured — and claims 5->6 for the one message A did not cover.
      const { service, createNotification, updateMany, rows } = makeService(6, {
        onAttempt: (attempt, folders) => { if (attempt === 0) folders[0].unreadCount = 5; },
      });

      await service.getFolders('u1');

      expect(createNotification).toHaveBeenCalledTimes(1);
      expect(createNotification.mock.calls[0][2]).toBe('1 new message');
      expect(createNotification.mock.calls[0][5]).toEqual({ baseline: 5, unreadCount: 6, delta: 1 });
      expect(updateMany).toHaveBeenLastCalledWith({
        where: { id: 'f-inbox', unreadCount: 5 }, data: { unreadCount: 6 },
      });
      expect(rows[0].unreadCount).toBe(6);
    });

    it('bounds the retries, so a pathological interleaving cannot spin', async () => {
      // A baseline that keeps moving and keeps landing below the measured
      // count would retry forever. Three attempts, then give up: this runs
      // inside every folder sync, and under-announcing one arrival is cheaper
      // than a loop that never returns.
      const { service, createNotification, updateMany, findUnique } = makeService(20, {
        onAttempt: (_attempt, folders) => { folders[0].unreadCount += 1; },
      });

      await service.getFolders('u1');

      expect(createNotification).not.toHaveBeenCalled();
      expect(updateMany).toHaveBeenCalledTimes(3);
      expect(findUnique).toHaveBeenCalledTimes(3);
      expect((MailService as any).NEW_MAIL_CLAIM_ATTEMPTS).toBe(3);
    });

    it('notifies a read-then-refill that repeats a transition announced SECONDS ago', async () => {
      // The sequence every timing guard here has lost. (0 -> 1) is announced
      // at t=0; the user opens the message, and a sync seconds later takes the
      // stored baseline back to 0; another message arrives, and the next sync
      // computes the identical (0 -> 1) pair well inside any plausible window.
      // Nothing about the numbers or the clock distinguishes it from a
      // duplicate — only the fact that the baseline genuinely returned to 0,
      // which is exactly what the conditional update tests.
      const { service, createNotification, updateMany } = makeService(1, { storedUnread: 0 });

      await service.getFolders('u1');

      expect(createNotification).toHaveBeenCalledTimes(1);
      expect(createNotification.mock.calls[0][5]).toEqual({ baseline: 0, unreadCount: 1, delta: 1 });
      expect(updateMany).toHaveBeenCalledWith({
        where: { id: 'f-inbox', unreadCount: 0 },
        data: { unreadCount: 1 },
      });
    });

    it('still returns the folder list, and creates no notification, when the claim itself throws', async () => {
      const { service, createNotification } = makeService(5, {
        updateMany: jest.fn().mockRejectedValue(new Error('deadlock detected')),
      });

      await expect(service.getFolders('u1')).resolves.toBeDefined();
      expect(createNotification).not.toHaveBeenCalled();
    });
  });

  describe('body text', () => {
    it('names the sender and subject of the newest unread message when the DB holds it', async () => {
      const { service, createNotification, messageFindFirst } = makeService(5, {
        newestUnread: { fromName: 'Alice Uwase', fromEmail: 'alice@risa.gov.rw', subject: 'Budget review' },
      });

      await service.getFolders('u1');

      expect(createNotification.mock.calls[0][3]).toBe('Alice Uwase — Budget review');
      // One indexed lookup, scoped to the stored Inbox folder and unread rows.
      expect(messageFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'u1', folderId: 'f-inbox', isRead: false },
          orderBy: { receivedAt: 'desc' },
        }),
      );
    });

    it('falls back to the sender address when the message has no display name', async () => {
      const { service, createNotification } = makeService(5, {
        newestUnread: { fromName: '  ', fromEmail: 'alice@risa.gov.rw', subject: null },
      });

      await service.getFolders('u1');

      expect(createNotification.mock.calls[0][3]).toBe('alice@risa.gov.rw — (no subject)');
    });

    it('falls back to the unread total when the DB holds no unread Inbox message', async () => {
      const { service, createNotification } = makeService(5, { newestUnread: null });
      await service.getFolders('u1');
      expect(createNotification.mock.calls[0][3]).toBe('Inbox now has 5 unread');
    });

    it('falls back to the unread total, and still notifies, when the message read throws', async () => {
      const { service, createNotification } = makeService(5, {
        messageFindFirst: jest.fn().mockRejectedValue(new Error('connection reset')),
      });

      await service.getFolders('u1');

      expect(createNotification).toHaveBeenCalledTimes(1);
      expect(createNotification.mock.calls[0][3]).toBe('Inbox now has 5 unread');
    });
  });
});
