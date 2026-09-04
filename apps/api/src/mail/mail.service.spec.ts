import { BadRequestException, ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { MailService } from './mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { ZimbraService } from '../zimbra/zimbra.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TasksService } from '../tasks/tasks.service';

function makeService() {
  const prisma = {
    user: { findUnique: jest.fn(), update: jest.fn() },
    senderRule: { findMany: jest.fn(), create: jest.fn(), findFirst: jest.fn(), delete: jest.fn() },
  } as unknown as PrismaService;
  const zimbra = {} as ZimbraService;
  const notifications = {} as NotificationsService;
  const tasksService = { create: jest.fn() } as unknown as TasksService;
  const service = new MailService(prisma, zimbra, notifications, tasksService);
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
  const user = { zimbraHost: 'mail.example.com', authToken: 'tok', csrfToken: 'csrf' };
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
    const service = new MailService(prisma, zimbra, notifications, tasksService);
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

    expect(zimbra.moveMessage).toHaveBeenCalledWith('mail.example.com', 'tok', 'z1', 'z-junk', 'csrf');
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
    const service = new MailService(prisma, zimbra, notifications, tasksService);
    return { service: service as any, prisma: prisma as any, zimbra: zimbra as any };
  }

  it('never runs enforcement inside the Inbox list GET, even with a blocked sender in the results', async () => {
    const { service, prisma, zimbra } = makeService();
    prisma.user.findUnique.mockResolvedValue(activeUser);
    prisma.folder.findFirst.mockResolvedValueOnce({ id: 'inbox-id', zimbraId: 'zfolder', userId: 'u1', path: '/Inbox' });
    zimbra.getMessages.mockResolvedValue({
      messages: [{ id: 'z1', e: [{ t: 'f', a: 'spam@evil.com', d: 'Spam' }], f: '', su: 'Subj', fr: 'snippet', d: Date.now() }],
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
    const service = new MailService(prisma, zimbra, notifications, tasksService);
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
    const service = new MailService(prisma, zimbra, notifications, tasksService);
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
    const service = new MailService(prisma, zimbra, notifications, tasksService);
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
    const service = new MailService(prisma, zimbra, notifications, tasksService);
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
    const service = new MailService(prisma, zimbra, notifications, tasksService);
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
    expect(result).toEqual({ taskId: 'task-1' });
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
});

describe('MailService.getMessage attachment classification', () => {
  const user = {
    id: 'u1',
    email: 'u@example.com',
    zimbraHost: 'mail.example.com',
    authToken: 'tok',
    csrfToken: null,
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
    const service = new MailService(prisma, zimbra, notifications, tasksService);
    return { service, prisma: prisma as any, zimbra: zimbra as any };
  }

  const cachedRow = { id: 'm1', zimbraId: 'z1', bodyHtml: null, bodyText: null, attachments: null, inlineImages: null };

  it('excludes CID-referenced inline images from the attachment list but keeps real attachments', async () => {
    const { service, prisma, zimbra } = makeService();
    prisma.message.findFirst.mockResolvedValue(cachedRow);
    zimbra.getMessage.mockResolvedValue({
      id: 'z1', l: '2', su: 'hi', d: Date.now(), f: '', e: [],
      mp: [
        { part: '1', ct: 'text/html', body: true, content: '<p>hi <img src="cid:sig@x"></p>' },
        { part: '2', ct: 'image/gif', filename: 'inline.gif', ci: '<sig@x>', s: 1234 },
        { part: '3', ct: 'application/pdf', filename: 'report.pdf', s: 99 },
      ],
    });

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
    zimbra.getMessage.mockResolvedValue({
      id: 'z1', l: '2', su: 'hi', d: Date.now(), f: '', e: [],
      mp: [
        { part: '1', ct: 'text/html', body: true, content: '<p>hi <img src="cid:sig@x"></p>' },
        { part: '2', ct: 'image/gif', filename: 'inline.gif', ci: '<sig@x>', s: 1234 },
      ],
    });

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
        ],
      }),
    } as unknown as ZimbraService;
    const service = new MailService(prisma, zimbra, {} as NotificationsService, {} as TasksService);

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
        messages: [{ id: 'z1', l: '2', su: 's', d: 1, f: '', e: [] }],
      }),
    } as unknown as ZimbraService;
    const service = new MailService(prisma, zimbra, {} as NotificationsService, {} as TasksService);

    await service.getConversation('u1', 'm1');

    expect((prisma as any).message.createMany).not.toHaveBeenCalled();
  });
});

describe('MailService.getMessage embed budget (async image embedding)', () => {
  const user = {
    id: 'u1',
    email: 'u@example.com',
    zimbraHost: 'mail.example.com',
    authToken: 'tok',
    csrfToken: null,
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
    const service = new MailService(prisma, zimbra, {} as NotificationsService, {} as TasksService);
    return { service, prisma: prisma as any, zimbra: zimbra as any };
  }

  const zimbraMsg = {
    id: 'z1', l: '2', su: 'hi', d: Date.now(), f: '', e: [],
    mp: [
      { part: '1', ct: 'text/html', body: true, content: '<p>hi <img src="cid:sig@x"></p>' },
      { part: '2', ct: 'image/gif', filename: 'inline.gif', ci: '<sig@x>', s: 1234 },
    ],
  };
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
});
