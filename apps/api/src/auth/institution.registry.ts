import { Injectable } from '@nestjs/common';
import { Institution } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const MEMORY_ROW: Institution = {
  id: 'memory', label: 'Demo (local)', provider: 'memory',
  host: 'memory.local', ewsDomain: null, emailDomain: 'memory.local',
  enabled: true, position: 9999,
};

/**
 * The address domain a login is for, lowercased — "" when the input has no
 * usable domain part. Shared with AuthService so the error message and the
 * lookup can never disagree about what the domain was.
 */
export function emailDomainOf(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 0) return '';
  const domain = email.slice(at + 1);
  return domain.trim().toLowerCase();
}

@Injectable()
export class InstitutionRegistry {
  constructor(private readonly prisma: PrismaService) {}

  private memoryEnabled(): boolean {
    return process.env.MAIL_PROVIDER_MEMORY === 'true';
  }

  /**
   * Institution list for ops and non-web clients — never exposes provider/host.
   * Login no longer uses this: it derives the institution from the address
   * domain via resolveByEmail.
   */
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

  /**
   * Map a login address to its institution by domain — this is how login works
   * now that the institution dropdown is gone. Exact domain match only, so
   * someone typing a mail hostname ("xyz@mail.risa.gov.rw") is not quietly
   * signed in to RISA.
   */
  async resolveByEmail(email: string): Promise<Institution | null> {
    const domain = emailDomainOf(email);
    // Must bail before touching Prisma: an empty value in a `where` is dropped
    // from the filter, so `{ emailDomain: undefined, enabled: true }` would
    // hand back the first enabled institution for a malformed address.
    if (!domain) return null;
    if (domain === MEMORY_ROW.emailDomain) {
      return this.memoryEnabled() ? MEMORY_ROW : null;
    }
    return this.prisma.institution.findFirst({
      where: { emailDomain: domain, enabled: true },
    });
  }
}
