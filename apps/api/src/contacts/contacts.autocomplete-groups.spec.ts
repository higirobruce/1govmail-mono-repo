import { ContactsService } from './contacts.service';

function makePrisma(groups: any[] = []) {
  return {
    user: { findUnique: jest.fn().mockResolvedValue({ id: 'u1', email: 'me@risa.gov.rw', authToken: 't', provider: 'zimbra', zimbraHost: 'h' }) },
    contactGroup: { findMany: jest.fn().mockResolvedValue(groups) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  } as any;
}

const makeResolver = () => ({
  forUser: () => ({
    autoCompleteContacts: jest.fn().mockResolvedValue([{ email: 'finance.desk@risa.gov.rw', display: 'Finance Desk' }]),
    searchGal: jest.fn().mockResolvedValue([]),
  }),
}) as any;

const FINANCE = {
  id: 'g1', name: 'Finance Team',
  members: [{ email: 'a@risa.gov.rw', name: 'A' }, { email: 'b@risa.gov.rw' }],
};

describe('ContactsService.autocomplete — groups', () => {
  it('returns no groups unless asked', async () => {
    const prisma = makePrisma([FINANCE]);
    const svc = new ContactsService(prisma, makeResolver());

    const out = await svc.autocomplete('u1', 'fin');

    expect(out.some((s: any) => s.kind === 'group')).toBe(false);
    expect(prisma.contactGroup.findMany).not.toHaveBeenCalled();
  });

  it('returns a matching group first when asked', async () => {
    const prisma = makePrisma([FINANCE]);
    const svc = new ContactsService(prisma, makeResolver());

    const out = await svc.autocomplete('u1', 'fin', { includeGroups: true });

    expect(out[0]).toEqual({
      kind: 'group',
      groupId: 'g1',
      display: 'Finance Team',
      memberCount: 2,
      members: [{ email: 'a@risa.gov.rw', name: 'A' }, { email: 'b@risa.gov.rw' }],
    });
    // Address suggestions still follow, unchanged in shape.
    expect(out[1]).toEqual({ email: 'finance.desk@risa.gov.rw', display: 'Finance Desk' });
  });

  it('matches group names case-insensitively', async () => {
    const prisma = makePrisma([FINANCE]);
    const svc = new ContactsService(prisma, makeResolver());

    const out = await svc.autocomplete('u1', 'FINANCE', { includeGroups: true });

    expect(out[0]).toMatchObject({ kind: 'group', groupId: 'g1' });
    // Pin that the query actually reached Prisma with case-insensitive matching —
    // a broken implementation that dropped `mode: 'insensitive'` (or matched
    // case-sensitively in JS instead) would still satisfy the assertion above
    // because the mock returns FINANCE regardless of the query it's called with.
    expect(prisma.contactGroup.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          name: { contains: 'FINANCE', mode: 'insensitive' },
        }),
      }),
    );
  });

  it('still returns addresses when the group lookup throws', async () => {
    const prisma = makePrisma([FINANCE]);
    prisma.contactGroup.findMany.mockRejectedValue(new Error('db down'));
    const svc = new ContactsService(prisma, makeResolver());

    const out = await svc.autocomplete('u1', 'fin', { includeGroups: true });

    expect(out).toEqual([{ email: 'finance.desk@risa.gov.rw', display: 'Finance Desk' }]);
  });
});
