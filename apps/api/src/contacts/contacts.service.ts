import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ZimbraService } from '../zimbra/zimbra.service';
import { buildMailSession } from '../provider/mail-session';
import { ProviderContact } from '../provider/provider-types';

export interface ContactData {
  firstName?: string;
  lastName?: string;
  fullName?: string;
  nickname?: string;
  company?: string;
  jobTitle?: string;
  email?: string;
  email2?: string;
  email3?: string;
  phone?: string;
  mobile?: string;
  homePhone?: string;
  notes?: string;
}

@Injectable()
export class ContactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly zimbra: ZimbraService,
  ) {}

  private async getUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (!user.authToken)
      throw new UnauthorizedException('Please log in again to connect to Zimbra.');
    return user;
  }

  /**
   * Convert a flat ContactData object (the REST/form shape) into the neutral
   * Partial<ProviderContact> the provider layer speaks. Zimbra-wire
   * serialization (the attrs array) now lives in
   * zimbra.mappers.ts#mapProviderContactToZimbraAttrs — this only builds the
   * role-tagged emails/phones arrays, which are ALSO exactly the shape the
   * `Contact.emails`/`Contact.phones` JSON columns store (and what apps/web
   * reads off the REST response), so the same object serves both the Zimbra
   * call and the Prisma write below.
   */
  private dataToProviderContact(data: ContactData): Partial<ProviderContact> {
    const emails: ProviderContact['emails'] = [];
    if (data.email) emails.push({ email: data.email, type: 'work', primary: true });
    if (data.email2) emails.push({ email: data.email2, type: 'personal' });
    if (data.email3) emails.push({ email: data.email3, type: 'other' });

    const phones: ProviderContact['phones'] = [];
    if (data.phone) phones.push({ number: data.phone, type: 'work' });
    if (data.mobile) phones.push({ number: data.mobile, type: 'mobile' });
    if (data.homePhone) phones.push({ number: data.homePhone, type: 'home' });

    const fullName =
      data.fullName ??
      (data.firstName || data.lastName
        ? [data.firstName, data.lastName].filter(Boolean).join(' ')
        : null);

    return {
      displayName: fullName,
      firstName: data.firstName,
      lastName: data.lastName,
      nickname: data.nickname,
      company: data.company,
      jobTitle: data.jobTitle,
      emails,
      phones,
      notes: data.notes,
    };
  }

  // ── Autocomplete (used by compose form) ────────────────────────────────────

  /**
   * Run AutoCompleteRequest (personal contacts + GAL via includeGal:1) and
   * SearchGalRequest in parallel, then merge + deduplicate by email address.
   * This ensures organisation-wide contacts always appear even when the
   * AutoComplete index hasn't indexed a GAL entry yet.
   */
  async autocomplete(
    userId: string,
    query: string,
  ): Promise<Array<{ email: string; display: string }>> {
    const q = (query ?? '').trim();
    if (!q) return [];
    const user = await this.getUser(userId);
    const session = buildMailSession(user);
    const [personal, gal, history] = await Promise.all([
      this.zimbra.autoCompleteContacts(session, q),
      this.zimbra.searchGal(session, q),
      this.autocompleteFromHistory(userId, q),
    ]);

    // Merge priority: Zimbra personal contacts + GAL first (richer display names
    // and organisational data), then fill in any addresses the user has seen in
    // their mail history — this matches Zimbra Web Client's behaviour where
    // previously-emailed-with addresses autocomplete even without being saved.
    const seen = new Set<string>();
    const merged: Array<{ email: string; display: string }> = [];
    for (const item of [...personal, ...gal, ...history]) {
      const key = item.email.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(item);
      }
    }
    return merged.slice(0, 20);
  }

  /**
   * Search the user's own mail history for addresses matching the query —
   * covers senders of received mail and recipients of sent mail, so the user
   * can autocomplete anyone they've corresponded with even if that person
   * isn't saved as a contact or in the GAL.
   *
   * Postgres-specific: identifiers are camelCase in the schema so they need
   * double-quoting (otherwise Postgres folds to lowercase), and we use ILIKE
   * for case-insensitive matching. JSONB recipient columns are cast to text
   * so LIKE works — good enough since we re-filter each entry in JS below.
   */
  private async autocompleteFromHistory(
    userId: string,
    query: string,
  ): Promise<Array<{ email: string; display: string }>> {
    const q = query.trim();
    if (q.length < 2) return [];
    const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;

    type Row = {
      fromEmail: string;
      fromName: string | null;
      toRecipients: unknown;
      ccRecipients: unknown;
      bccRecipients: unknown;
    };
    let rows: Row[] = [];
    try {
      rows = await this.prisma.$queryRaw<Row[]>`
        SELECT "fromEmail", "fromName", "toRecipients", "ccRecipients", "bccRecipients"
        FROM messages
        WHERE "userId" = ${userId}
          AND (
            "fromEmail"              ILIKE ${like} OR
            "fromName"               ILIKE ${like} OR
            "toRecipients"::text     ILIKE ${like} OR
            "ccRecipients"::text     ILIKE ${like} OR
            "bccRecipients"::text    ILIKE ${like}
          )
        ORDER BY "receivedAt" DESC
        LIMIT 300
      `;
    } catch (err: any) {
      // Never throw — autocomplete must degrade gracefully to Zimbra-only results
      console.warn(`autocompleteFromHistory: ${err?.message ?? err}`);
      return [];
    }

    const qLower = q.toLowerCase();
    const map = new Map<string, { email: string; display: string }>();
    const consider = (email?: string | null, name?: string | null) => {
      if (!email) return;
      const trimmed = email.trim();
      if (!trimmed) return;
      const hay = `${trimmed} ${name ?? ''}`.toLowerCase();
      if (!hay.includes(qLower)) return;
      const key = trimmed.toLowerCase();
      if (map.has(key)) return;
      const display = name && name.trim() && name.trim() !== trimmed ? name.trim() : trimmed;
      map.set(key, { email: trimmed, display });
    };

    // JSONB columns are returned as already-parsed objects/arrays by the pg driver.
    const toArray = (v: unknown): Array<{ email?: string; name?: string | null }> => {
      if (Array.isArray(v)) return v as any[];
      if (typeof v === 'string') {
        try { const parsed = JSON.parse(v); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
      }
      return [];
    };

    for (const r of rows) {
      consider(r.fromEmail, r.fromName);
      for (const field of [r.toRecipients, r.ccRecipients, r.bccRecipients]) {
        for (const entry of toArray(field)) consider(entry?.email, entry?.name ?? null);
      }
      if (map.size >= 40) break;
    }

    return Array.from(map.values());
  }

  // ── List / sync ────────────────────────────────────────────────────────────

  async getContacts(userId: string, query?: string, sync = false): Promise<any[]> {
    const user = await this.getUser(userId);

    const count = await this.prisma.contact.count({ where: { userId } });
    if (count === 0 || sync) {
      await this.syncFromZimbra(userId, user);
    }

    const where: any = { userId };
    if (query && query.trim()) {
      const q = query.trim();
      // SQLite's LIKE is case-insensitive for ASCII by default; no mode needed.
      where.OR = [
        { firstName: { contains: q } },
        { lastName:  { contains: q } },
        { fullName:  { contains: q } },
        { company:   { contains: q } },
        { nickname:  { contains: q } },
      ];
    }

    return this.prisma.contact.findMany({
      where,
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      take: 300,
    });
  }

  private async syncFromZimbra(userId: string, user: any): Promise<void> {
    const contacts = await this.zimbra.getContacts(buildMailSession(user));

    for (const c of contacts) {
      // `String(raw.id)` in the mapper always yields a non-empty string (even
      // "undefined" when Zimbra omits `id`), so this guard never actually
      // trips — kept to match the pre-Task-7 `if (!parsed.zimbraId) continue`
      // exactly rather than silently dropping a defensive check.
      if (!c.id) continue;

      await this.prisma.contact.upsert({
        where: { userId_zimbraId: { userId, zimbraId: c.id } },
        create: {
          userId,
          zimbraId: c.id,
          firstName: c.firstName ?? null,
          lastName:  c.lastName ?? null,
          fullName:  c.displayName,
          nickname:  c.nickname ?? null,
          company:   c.company ?? null,
          jobTitle:  c.jobTitle ?? null,
          emails:    c.emails as any,
          phones:    c.phones as any,
          notes:     c.notes ?? null,
          syncedAt:  new Date(),
        },
        update: {
          firstName: c.firstName ?? null,
          lastName:  c.lastName ?? null,
          fullName:  c.displayName,
          nickname:  c.nickname ?? null,
          company:   c.company ?? null,
          jobTitle:  c.jobTitle ?? null,
          emails:    c.emails as any,
          phones:    c.phones as any,
          notes:     c.notes ?? null,
          syncedAt:  new Date(),
        },
      });
    }
  }

  // ── Create ─────────────────────────────────────────────────────────────────

  async createContact(userId: string, data: ContactData): Promise<any> {
    const user = await this.getUser(userId);
    const providerContact = this.dataToProviderContact(data);
    const created = await this.zimbra.createContact(buildMailSession(user), providerContact);

    return this.prisma.contact.create({
      data: {
        userId,
        zimbraId:  created.id,
        firstName: data.firstName ?? null,
        lastName:  data.lastName  ?? null,
        fullName:  providerContact.displayName ?? null,
        nickname:  data.nickname  ?? null,
        company:   data.company   ?? null,
        jobTitle:  data.jobTitle  ?? null,
        emails:    providerContact.emails as any,
        phones:    providerContact.phones as any,
        notes:     data.notes ?? null,
        syncedAt:  new Date(),
      },
    });
  }

  // ── Update ─────────────────────────────────────────────────────────────────

  async updateContact(
    userId: string,
    contactId: string,
    data: ContactData,
  ): Promise<any> {
    const user = await this.getUser(userId);
    const contact = await this.prisma.contact.findFirst({
      where: { id: contactId, userId },
    });
    if (!contact) throw new NotFoundException('Contact not found');

    const providerContact = this.dataToProviderContact(data);
    await this.zimbra.modifyContact(buildMailSession(user), contact.zimbraId, providerContact);

    return this.prisma.contact.update({
      where: { id: contactId },
      data: {
        firstName: data.firstName ?? null,
        lastName:  data.lastName  ?? null,
        fullName:  providerContact.displayName ?? null,
        nickname:  data.nickname  ?? null,
        company:   data.company   ?? null,
        jobTitle:  data.jobTitle  ?? null,
        emails:    providerContact.emails as any,
        phones:    providerContact.phones as any,
        notes:     data.notes ?? null,
      },
    });
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  async deleteContact(
    userId: string,
    contactId: string,
  ): Promise<{ success: boolean }> {
    const user = await this.getUser(userId);
    const contact = await this.prisma.contact.findFirst({
      where: { id: contactId, userId },
    });
    if (!contact) throw new NotFoundException('Contact not found');

    await this.zimbra.deleteContact(buildMailSession(user), contact.zimbraId);
    await this.prisma.contact.delete({ where: { id: contactId } });
    return { success: true };
  }

  // ── Contact Groups ────────────────────────────────────────────────────────

  async getGroups(userId: string) {
    return this.prisma.contactGroup.findMany({
      where: { userId },
      orderBy: { name: 'asc' },
    });
  }

  async createGroup(userId: string, data: { name: string; description?: string; members?: { email: string; name?: string }[] }) {
    return this.prisma.contactGroup.create({
      data: {
        userId,
        name: data.name,
        description: data.description ?? null,
        members: (data.members ?? []) as any,
      },
    });
  }

  async updateGroup(userId: string, groupId: string, data: { name?: string; description?: string; members?: { email: string; name?: string }[] }) {
    const group = await this.prisma.contactGroup.findFirst({ where: { id: groupId, userId } });
    if (!group) throw new NotFoundException('Group not found');
    return this.prisma.contactGroup.update({
      where: { id: groupId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.members !== undefined && { members: data.members as any }),
      },
    });
  }

  async deleteGroup(userId: string, groupId: string): Promise<{ success: boolean }> {
    const group = await this.prisma.contactGroup.findFirst({ where: { id: groupId, userId } });
    if (!group) throw new NotFoundException('Group not found');
    await this.prisma.contactGroup.delete({ where: { id: groupId } });
    return { success: true };
  }
}
