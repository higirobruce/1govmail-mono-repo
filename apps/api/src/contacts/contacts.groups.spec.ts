import { BadRequestException, NotFoundException } from '@nestjs/common';
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

  // The client keeps the Edit control visible by finding its own EDITOR invite in
  // the group it holds. If the update response omits `invites`, an EDITOR loses
  // the button the moment they use it, and only a full reload brings it back.
  it('returns the invites on the updated group, so an EDITOR keeps edit rights', async () => {
    const { svc, prisma } = svcFor(sharedEditor);
    await svc.updateGroup('u1', 'g1', { name: 'Renamed' });
    expect(prisma.contactGroup.update).toHaveBeenCalledWith(
      expect.objectContaining({ include: { invites: true } }),
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

describe('ContactsService group shares', () => {
  function ownerSvc() {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'me@risa.gov.rw', authToken: 't' });
    prisma.contactGroup.findFirst.mockResolvedValue({ id: 'g1', userId: 'u1', invites: [] });
    prisma.groupInvite.upsert.mockImplementation(({ create }: any) => Promise.resolve({ id: 'i1', ...create }));
    prisma.groupInvite.findFirst.mockResolvedValue({ id: 'i1', groupId: 'g1' });
    prisma.groupInvite.delete.mockResolvedValue({ id: 'i1' });
    return { prisma, svc: makeService(prisma) };
  }

  // Review Focus #1 — normalise on write, so read-side matching can succeed.
  it('stores the invited email trimmed and lowercased', async () => {
    const { svc, prisma } = ownerSvc();
    await svc.addShare('u1', 'g1', { email: '  Alice@Risa.Gov.RW  ' });
    expect(prisma.groupInvite.upsert.mock.calls[0][0].create.invitedEmail).toBe('alice@risa.gov.rw');
  });

  it('defaults a new invite to VIEWER', async () => {
    const { svc, prisma } = ownerSvc();
    await svc.addShare('u1', 'g1', { email: 'alice@risa.gov.rw' });
    expect(prisma.groupInvite.upsert.mock.calls[0][0].create.role).toBe('VIEWER');
  });

  // Review Focus #2 — re-inviting must update the role, not raise P2002.
  it('re-inviting the same email is idempotent and updates the role', async () => {
    const { svc, prisma } = ownerSvc();
    await svc.addShare('u1', 'g1', { email: 'alice@risa.gov.rw', role: 'EDITOR' });
    const call = prisma.groupInvite.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ groupId_invitedEmail: { groupId: 'g1', invitedEmail: 'alice@risa.gov.rw' } });
    expect(call.update).toEqual({ role: 'EDITOR' });
    expect(call.create).toEqual({
      groupId: 'g1',
      invitedEmail: 'alice@risa.gov.rw',
      invitedBy: 'u1',
      role: 'EDITOR',
    });
  });

  it('refuses inviting yourself', async () => {
    const { svc, prisma } = ownerSvc();
    await expect(svc.addShare('u1', 'g1', { email: 'ME@risa.gov.rw' })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.groupInvite.upsert).not.toHaveBeenCalled();
  });

  it('refuses a non-owner sharing', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'me@risa.gov.rw', authToken: 't' });
    prisma.contactGroup.findFirst.mockResolvedValue({
      id: 'g1', userId: 'owner',
      invites: [{ invitedEmail: 'me@risa.gov.rw', role: 'EDITOR' }],
    });
    const svc = makeService(prisma);
    await expect(svc.addShare('u1', 'g1', { email: 'x@risa.gov.rw' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses revoking an invite belonging to another group', async () => {
    const { svc, prisma } = ownerSvc();
    prisma.groupInvite.findFirst.mockResolvedValue(null);
    await expect(svc.removeShare('u1', 'g1', 'i9')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.groupInvite.findFirst).toHaveBeenCalledWith({
      where: { id: 'i9', groupId: 'g1' },
    });
    expect(prisma.groupInvite.delete).not.toHaveBeenCalled();
  });

  // Carried from Task 3's review: requireGroupAccess's 'read' branch had no
  // test yet. listShares is the first caller to use it — prove a VIEWER
  // invitee (not just the owner) can list shares, exercising that branch.
  it('lets a VIEWER invitee list shares', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({ id: 'u2', email: 'viewer@risa.gov.rw', authToken: 't' });
    prisma.contactGroup.findFirst.mockResolvedValue({
      id: 'g1', userId: 'owner',
      invites: [{ invitedEmail: 'viewer@risa.gov.rw', role: 'VIEWER' }],
    });
    prisma.groupInvite.findMany.mockResolvedValue([
      { id: 'i1', groupId: 'g1', invitedEmail: 'viewer@risa.gov.rw', role: 'VIEWER' },
    ]);
    const svc = makeService(prisma);

    await expect(svc.listShares('u2', 'g1')).resolves.toEqual([
      { id: 'i1', groupId: 'g1', invitedEmail: 'viewer@risa.gov.rw', role: 'VIEWER' },
    ]);
    expect(prisma.groupInvite.findMany).toHaveBeenCalledWith({
      where: { groupId: 'g1' },
      orderBy: { createdAt: 'asc' },
    });
  });
});
