import { NotFoundException } from '@nestjs/common';
import { ContactsService } from './contacts.service';

function makePrisma() {
  return {
    user: { findUnique: jest.fn() },
    contactGroup: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    groupInvite: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    },
  } as any;
}

const makeService = (prisma: any) => new ContactsService(prisma, {} as any);

describe('ContactsService.getGroups — access', () => {
  it('returns groups I own and groups shared with me', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'me@risa.gov.rw', authToken: 't' });
    const svc = makeService(prisma);

    await svc.getGroups('u1');

    expect(prisma.contactGroup.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { userId: 'u1' },
            { invites: { some: { invitedEmail: 'me@risa.gov.rw' } } },
          ],
        },
        include: { invites: true },
      }),
    );
  });

  // Review Focus #1 — an invite stored under a different case must still match.
  it('normalises the caller email before matching invites', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: '  Me@Risa.Gov.RW ', authToken: 't' });
    const svc = makeService(prisma);

    await svc.getGroups('u1');

    const where = prisma.contactGroup.findMany.mock.calls[0][0].where;
    expect(where.OR[1]).toEqual({ invites: { some: { invitedEmail: 'me@risa.gov.rw' } } });
  });

  // The getUserEmail regression guard: listing groups is a local DB read and
  // must not require a live Zimbra token.
  it('lists groups when authToken is null', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'me@risa.gov.rw', authToken: null });
    const svc = makeService(prisma);

    await expect(svc.getGroups('u1')).resolves.toEqual([]);
  });

  it('throws NotFound when the user row is missing', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue(null);
    const svc = makeService(prisma);

    await expect(svc.getGroups('u1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ContactsService group writes — role gates', () => {
  const owned = { id: 'g1', userId: 'u1', name: 'Finance', members: [], invites: [] };
  const sharedViewer = {
    id: 'g1', userId: 'owner', name: 'Finance', members: [],
    invites: [{ invitedEmail: 'me@risa.gov.rw', role: 'VIEWER' }],
  };
  const sharedEditor = {
    id: 'g1', userId: 'owner', name: 'Finance', members: [],
    invites: [{ invitedEmail: 'me@risa.gov.rw', role: 'EDITOR' }],
  };

  function svcFor(group: any) {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'me@risa.gov.rw', authToken: 't' });
    prisma.contactGroup.findFirst.mockResolvedValue(group);
    prisma.contactGroup.update.mockResolvedValue({ ...group, name: 'Renamed' });
    prisma.contactGroup.delete.mockResolvedValue(group);
    return { prisma, svc: makeService(prisma) };
  }

  it('lets the owner edit', async () => {
    const { svc, prisma } = svcFor(owned);
    await svc.updateGroup('u1', 'g1', { name: 'Renamed' });
    expect(prisma.contactGroup.update).toHaveBeenCalled();
  });

  it('lets an EDITOR invitee edit', async () => {
    const { svc, prisma } = svcFor(sharedEditor);
    await svc.updateGroup('u1', 'g1', { name: 'Renamed' });
    expect(prisma.contactGroup.update).toHaveBeenCalled();
    expect(prisma.contactGroup.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'g1',
          OR: [
            { userId: 'u1' },
            { invites: { some: { invitedEmail: 'me@risa.gov.rw' } } },
          ],
        },
      }),
    );
  });

  it('refuses a VIEWER invitee editing', async () => {
    const { svc, prisma } = svcFor(sharedViewer);
    await expect(svc.updateGroup('u1', 'g1', { name: 'Renamed' })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.contactGroup.update).not.toHaveBeenCalled();
  });

  it('refuses a stranger editing', async () => {
    const { svc, prisma } = svcFor(null);
    await expect(svc.updateGroup('u1', 'g1', { name: 'Renamed' })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.contactGroup.update).not.toHaveBeenCalled();
  });

  it('lets only the owner delete — an EDITOR cannot', async () => {
    const { svc, prisma } = svcFor(sharedEditor);
    await expect(svc.deleteGroup('u1', 'g1')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.contactGroup.delete).not.toHaveBeenCalled();
  });

  it('lets the owner delete', async () => {
    const { svc, prisma } = svcFor(owned);
    await expect(svc.deleteGroup('u1', 'g1')).resolves.toEqual({ success: true });
    expect(prisma.contactGroup.delete).toHaveBeenCalledWith({ where: { id: 'g1' } });
  });
});
