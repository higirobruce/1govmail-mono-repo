import { MailService } from './mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { ZimbraService } from '../zimbra/zimbra.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TasksService } from '../tasks/tasks.service';
import { mapZimbraMessage } from '../zimbra/zimbra.mappers';
import { MailProviderResolver } from '../provider/mail-provider.resolver';

const makeResolver = (zimbra: any) => new MailProviderResolver(zimbra as ZimbraService);

// The list sync used to persist `toRecipients` only — cc/bcc were dropped on
// insert and NO recipient field was refreshed on update, so a row first written
// without recipients (a pre-`recip=2` sync, or an EWS FindItem that returns
// none) stayed empty forever and the UI could never show who a mail was
// addressed to. Refreshing has to be one-directional: a payload carrying no
// addresses must never overwrite a full list a message open already stored.
describe('MailService.getMessages recipient persistence', () => {
  const activeUser = {
    id: 'u1',
    zimbraHost: 'mail.example.com',
    authToken: 'tok',
    csrfToken: 'csrf',
    provider: 'zimbra',
    tokenExpiry: new Date(Date.now() + 60_000),
  };

  function makeListService() {
    const prisma = {
      user: { findUnique: jest.fn(), update: jest.fn() },
      folder: { findFirst: jest.fn() },
      message: { upsert: jest.fn(), update: jest.fn() },
      senderRule: { findMany: jest.fn() },
    } as unknown as PrismaService;
    const zimbra = { getMessages: jest.fn(), moveMessage: jest.fn() } as unknown as ZimbraService;
    const service = new MailService(
      prisma,
      makeResolver(zimbra),
      {} as NotificationsService,
      { create: jest.fn() } as unknown as TasksService,
    );
    return { service: service as any, prisma: prisma as any, zimbra: zimbra as any };
  }

  /** Runs one folder-list sync over a message carrying `rawAddresses`, and
   *  returns the prisma upsert args so the create/update halves can be read. */
  async function runList(rawAddresses: any[]) {
    const { service, prisma, zimbra } = makeListService();
    prisma.user.findUnique.mockResolvedValue(activeUser);
    prisma.folder.findFirst.mockResolvedValueOnce({
      id: 'inbox-id', zimbraId: 'zfolder', userId: 'u1', path: '/Inbox',
    });
    zimbra.getMessages.mockResolvedValue({
      messages: [mapZimbraMessage({
        id: 'z1', l: 'zfolder', e: rawAddresses,
        f: '', su: 'Subj', fr: 'snippet', d: Date.now(),
      } as any)],
      total: 1,
      more: false,
    });
    prisma.message.upsert.mockResolvedValue({ id: 'm1', zimbraId: 'z1' });

    await service.getMessages('u1', 'inbox-id');
    return prisma.message.upsert.mock.calls[0][0];
  }

  const WITH_RECIPIENTS = [
    { t: 'f', a: 'alice@risa.gov.rw', d: 'Alice' },
    { t: 't', a: 'me@risa.gov.rw',    d: 'Me' },
    { t: 't', a: 'peer@risa.gov.rw',  d: 'Peer' },
    { t: 'c', a: 'cc@risa.gov.rw',    d: 'Carol' },
    { t: 'b', a: 'bcc@risa.gov.rw',   d: 'Bob' },
  ];

  it('persists cc and bcc on insert, not just the to list', async () => {
    const args = await runList(WITH_RECIPIENTS);

    expect(args.create.toRecipients).toEqual([
      { email: 'me@risa.gov.rw',   name: 'Me' },
      { email: 'peer@risa.gov.rw', name: 'Peer' },
    ]);
    expect(args.create.ccRecipients).toEqual([{ email: 'cc@risa.gov.rw', name: 'Carol' }]);
    expect(args.create.bccRecipients).toEqual([{ email: 'bcc@risa.gov.rw', name: 'Bob' }]);
  });

  it('refreshes recipients on update so a row synced without them heals', async () => {
    const args = await runList(WITH_RECIPIENTS);

    expect(args.update.toRecipients).toEqual([
      { email: 'me@risa.gov.rw',   name: 'Me' },
      { email: 'peer@risa.gov.rw', name: 'Peer' },
    ]);
    expect(args.update.ccRecipients).toEqual([{ email: 'cc@risa.gov.rw', name: 'Carol' }]);
  });

  it('leaves stored recipients untouched when the provider returns none', async () => {
    // Sender only — a payload with no recipient roles must not blank out
    // addresses a full message fetch already persisted.
    const args = await runList([{ t: 'f', a: 'alice@risa.gov.rw', d: 'Alice' }]);

    expect(args.update).not.toHaveProperty('toRecipients');
    expect(args.update).not.toHaveProperty('ccRecipients');
    expect(args.update).not.toHaveProperty('bccRecipients');
  });
});

// Search results are persisted through their own upsert (a batched transaction,
// separate from the folder-list path) and hand back an `ephemeral` shape for
// hits whose folder is not synced yet. Both dropped cc/bcc, so a thread opened
// from search showed no CC at all.
describe('MailService.searchMessages recipient persistence', () => {
  const user = {
    id: 'u1', email: 'u@example.com', zimbraHost: 'mail.example.com',
    authToken: 'tok', csrfToken: null, provider: 'zimbra',
    tokenExpiry: new Date(Date.now() + 60_000),
  };

  const providerMessage = (folderId: string) => ({
    id: 'z1', conversationId: 'c1', folderId, subject: 'Budget', snippet: 's',
    from: { email: 'alice@risa.gov.rw', name: 'Alice' },
    to:  [{ email: 'me@risa.gov.rw', name: 'Me' }],
    cc:  [{ email: 'cc@risa.gov.rw', name: 'Carol' }],
    bcc: [{ email: 'bcc@risa.gov.rw', name: 'Bob' }],
    receivedAt: new Date('2026-09-01'), size: 10,
    isRead: false, isFlagged: false, hasAttachments: false, isDraft: false, tags: [],
  });

  function makeService(messages: any[]) {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(user) },
      folder: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([{ id: 'f-inbox', zimbraId: '2' }]),
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
    const service = new MailService(
      prisma, makeResolver(zimbra), {} as NotificationsService, {} as TasksService,
    );
    return { service: service as any, prisma: prisma as any };
  }

  it('persists cc and bcc for a search hit', async () => {
    const { service, prisma } = makeService([providerMessage('2')]);

    await service.searchMessages('u1', 'budget', 50, 0);

    const { create } = prisma.message.upsert.mock.calls[0][0];
    expect(create.ccRecipients).toEqual([{ email: 'cc@risa.gov.rw', name: 'Carol' }]);
    expect(create.bccRecipients).toEqual([{ email: 'bcc@risa.gov.rw', name: 'Bob' }]);
  });

  it('refreshes recipients on a re-found hit without clobbering on an empty payload', async () => {
    const { service, prisma } = makeService([providerMessage('2')]);

    await service.searchMessages('u1', 'budget', 50, 0);

    expect(prisma.message.upsert.mock.calls[0][0].update.ccRecipients)
      .toEqual([{ email: 'cc@risa.gov.rw', name: 'Carol' }]);
  });

  it('heals the stored To list when the full message is opened', async () => {
    // GetMsg is the authoritative fetch — it already refreshed cc/bcc but left
    // toRecipients alone, so a row listed before `recip=2` kept an empty To.
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(user) },
      message: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'm1', zimbraId: 'z1', bodyHtml: null, bodyText: null, toRecipients: [],
        }),
        update: jest.fn().mockResolvedValue({ id: 'm1' }),
        updateMany: jest.fn(),
      },
      folder: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const zimbra = {
      getMessage: jest.fn().mockResolvedValue({
        ...providerMessage('2'),
        bodyHtml: '<p>hi</p>', bodyText: 'hi', attachments: [],
      }),
    } as unknown as ZimbraService;
    const service = new MailService(
      prisma, makeResolver(zimbra), {} as NotificationsService, {} as TasksService,
    ) as any;

    await service.getMessage('u1', 'm1');

    const { data } = (prisma as any).message.update.mock.calls[0][0];
    expect(data.toRecipients).toEqual([{ email: 'me@risa.gov.rw', name: 'Me' }]);
  });

  it('carries cc and bcc on an ephemeral hit whose folder is not synced', async () => {
    // folderId '99' is not in the folder map — the hit degrades to the
    // in-memory shape, which must still tell the UI who was copied.
    const { service } = makeService([providerMessage('99')]);

    const out = await service.searchMessages('u1', 'budget', 50, 0);

    expect(out.messages[0].ccRecipients).toEqual([{ email: 'cc@risa.gov.rw', name: 'Carol' }]);
    expect(out.messages[0].bccRecipients).toEqual([{ email: 'bcc@risa.gov.rw', name: 'Bob' }]);
  });
});
