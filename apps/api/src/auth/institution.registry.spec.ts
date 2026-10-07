import { Test } from '@nestjs/testing';
import { InstitutionRegistry } from './institution.registry';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Mirrors Prisma's `where` semantics, including the sharp edge that an
 * `undefined` value is DROPPED from the filter rather than matching nothing —
 * so `{ emailDomain: undefined, enabled: true }` matches every enabled row.
 * The registry has to rule out a missing domain itself, and this mock is what
 * makes a test able to prove it does.
 */
function matches(row: any, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where)
    .filter(([, v]) => v !== undefined)
    .every(([k, v]) => row[k] === v);
}

const rows = [
  { id: 'risa', label: 'RISA', provider: 'zimbra', host: 'mail.risa.gov.rw:8443', ewsDomain: null, emailDomain: 'risa.gov.rw', enabled: true, position: 0 },
  { id: 'minaffet', label: 'MINAFFET', provider: 'ews', host: 'webmail.minaffet.gov.rw', ewsDomain: 'MINAFFET', emailDomain: 'minaffet.gov.rw', enabled: true, position: 2 },
  // Retired institution: its domain must not resolve, even though the row survives.
  { id: 'retired', label: 'Retired', provider: 'zimbra', host: 'mail.retired.gov.rw', ewsDomain: null, emailDomain: 'retired.gov.rw', enabled: false, position: 3 },
  // Hand-added row with no domain mapping — reachable by id, never by email.
  { id: 'unmapped', label: 'Unmapped', provider: 'zimbra', host: 'mail.unmapped.gov.rw', ewsDomain: null, emailDomain: null, enabled: true, position: 4 },
];

describe('InstitutionRegistry', () => {
  let registry: InstitutionRegistry;
  const prisma = {
    institution: {
      findMany: jest.fn(async ({ where }: any) => rows.filter((r) => matches(r, where))),
      findUnique: jest.fn(async ({ where }: any) => rows.find((r) => r.id === where.id) ?? null),
      findFirst: jest.fn(async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null),
    },
  };

  beforeEach(async () => {
    delete process.env.MAIL_PROVIDER_MEMORY;
    const mod = await Test.createTestingModule({
      providers: [InstitutionRegistry, { provide: PrismaService, useValue: prisma }],
    }).compile();
    registry = mod.get(InstitutionRegistry);
  });

  it('lists enabled institutions as id+label only, ordered by position', async () => {
    const list = await registry.list();
    expect(list).toEqual([
      { id: 'risa', label: 'RISA' },
      { id: 'minaffet', label: 'MINAFFET' },
      { id: 'unmapped', label: 'Unmapped' },
    ]);
    expect(prisma.institution.findMany).toHaveBeenCalledWith({
      where: { enabled: true },
      orderBy: { position: 'asc' },
    });
  });

  it('appends the demo entry only when MAIL_PROVIDER_MEMORY=true', async () => {
    process.env.MAIL_PROVIDER_MEMORY = 'true';
    const list = await registry.list();
    expect(list[list.length - 1]).toEqual({ id: 'memory', label: 'Demo (local)' });
  });

  it('resolve returns the full row, or the synthetic memory row when enabled', async () => {
    expect((await registry.resolve('minaffet'))?.ewsDomain).toBe('MINAFFET');
    expect(await registry.resolve('memory')).toBeNull();
    process.env.MAIL_PROVIDER_MEMORY = 'true';
    expect((await registry.resolve('memory'))?.provider).toBe('memory');
  });

  it('resolveByHost matches the legacy zimbraHost field', async () => {
    expect((await registry.resolveByHost('mail.risa.gov.rw:8443'))?.id).toBe('risa');
    expect(await registry.resolveByHost('evil.example.com')).toBeNull();
  });

  describe('resolveByEmail', () => {
    it('maps an address domain to its institution', async () => {
      expect((await registry.resolveByEmail('ajs@minaffet.gov.rw'))?.id).toBe('minaffet');
      expect((await registry.resolveByEmail('xyz@risa.gov.rw'))?.id).toBe('risa');
    });

    it('is case-insensitive about the address', async () => {
      expect((await registry.resolveByEmail('XYZ@RISA.GOV.RW'))?.id).toBe('risa');
    });

    it('returns null for a domain no institution claims', async () => {
      expect(await registry.resolveByEmail('joe@gmail.com')).toBeNull();
    });

    it('matches the domain exactly, so a mail subdomain is not the institution', async () => {
      // Someone typing their server hostname instead of their address must not
      // be silently signed in to RISA.
      expect(await registry.resolveByEmail('xyz@mail.risa.gov.rw')).toBeNull();
    });

    it('will not resolve a disabled institution', async () => {
      expect(await registry.resolveByEmail('someone@retired.gov.rw')).toBeNull();
    });

    it('resolves the demo domain only when MAIL_PROVIDER_MEMORY=true', async () => {
      expect(await registry.resolveByEmail('demo@memory.local')).toBeNull();
      process.env.MAIL_PROVIDER_MEMORY = 'true';
      expect((await registry.resolveByEmail('demo@memory.local'))?.provider).toBe('memory');
    });

    it('returns null when the address has no domain part', async () => {
      // Guards the Prisma trap: querying `{ emailDomain: undefined }` drops the
      // filter and would hand back the first enabled institution instead.
      expect(await registry.resolveByEmail('not-an-address')).toBeNull();
      expect(await registry.resolveByEmail('trailing@')).toBeNull();
      expect(await registry.resolveByEmail('')).toBeNull();
    });
  });
});
