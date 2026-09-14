import { Test } from '@nestjs/testing';
import { InstitutionRegistry } from './institution.registry';
import { PrismaService } from '../prisma/prisma.service';

const rows = [
  { id: 'risa', label: 'RISA', provider: 'zimbra', host: 'mail.risa.gov.rw:8443', ewsDomain: null, enabled: true, position: 0 },
  { id: 'minaffet', label: 'MINAFFET', provider: 'ews', host: 'webmail.minaffet.gov.rw', ewsDomain: 'MINAFFET', enabled: true, position: 2 },
];

describe('InstitutionRegistry', () => {
  let registry: InstitutionRegistry;
  const prisma = {
    institution: {
      findMany: jest.fn(async () => rows),
      findUnique: jest.fn(async ({ where }: any) => rows.find((r) => r.id === where.id) ?? null),
      findFirst: jest.fn(async ({ where }: any) => rows.find((r) => r.host === where.host && r.enabled) ?? null),
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
});
