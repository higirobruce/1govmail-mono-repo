import { Injectable } from '@nestjs/common';
import { Institution } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const MEMORY_ROW: Institution = {
  id: 'memory', label: 'Demo (local)', provider: 'memory',
  host: 'memory.local', ewsDomain: null, enabled: true, position: 9999,
};

@Injectable()
export class InstitutionRegistry {
  constructor(private readonly prisma: PrismaService) {}

  private memoryEnabled(): boolean {
    return process.env.MAIL_PROVIDER_MEMORY === 'true';
  }

  /** Login dropdown payload — never exposes provider/host. */
  async list(): Promise<Array<{ id: string; label: string }>> {
    const rows = await this.prisma.institution.findMany({
      where: { enabled: true },
      orderBy: { position: 'asc' },
    });
    const out = rows.map((r) => ({ id: r.id, label: r.label }));
    if (this.memoryEnabled()) out.push({ id: MEMORY_ROW.id, label: MEMORY_ROW.label });
    return out;
  }

  async resolve(id: string): Promise<Institution | null> {
    if (id === 'memory') return this.memoryEnabled() ? MEMORY_ROW : null;
    const row = await this.prisma.institution.findUnique({ where: { id } });
    return row?.enabled ? row : null;
  }

  /** Legacy support: map a client-supplied host back to its institution. */
  async resolveByHost(host: string): Promise<Institution | null> {
    return this.prisma.institution.findFirst({ where: { host, enabled: true } });
  }
}
