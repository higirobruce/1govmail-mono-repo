import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ZimbraService } from '../zimbra/zimbra.service';

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

  /** Parse a raw Zimbra contact node (supports both _attrs and a[] formats). */
  private parseZimbraContact(raw: any): {
    zimbraId: string;
    firstName: string | null;
    lastName: string | null;
    fullName: string | null;
    nickname: string | null;
    company: string | null;
    jobTitle: string | null;
    emails: Array<{ email: string; type: string; primary?: boolean }>;
    phones: Array<{ number: string; type: string }>;
    notes: string | null;
  } {
    // Zimbra returns _attrs in SearchResponse and a[] in GetContactsResponse
    let attrs: Record<string, string> = {};
    if (raw._attrs) {
      attrs = raw._attrs as Record<string, string>;
    } else if (Array.isArray(raw.a)) {
      for (const a of raw.a) {
        if (a.n && a._content != null) attrs[a.n] = String(a._content);
      }
    }

    const emails: Array<{ email: string; type: string; primary?: boolean }> = [];
    if (attrs.email) emails.push({ email: attrs.email, type: 'work', primary: true });
    if (attrs.email2) emails.push({ email: attrs.email2, type: 'personal' });
    if (attrs.email3) emails.push({ email: attrs.email3, type: 'other' });

    const phones: Array<{ number: string; type: string }> = [];
    if (attrs.workPhone) phones.push({ number: attrs.workPhone, type: 'work' });
    if (attrs.mobilePhone) phones.push({ number: attrs.mobilePhone, type: 'mobile' });
    if (attrs.homePhone) phones.push({ number: attrs.homePhone, type: 'home' });

    const firstName = attrs.firstName ?? null;
    const lastName = attrs.lastName ?? null;
    const fullName =
      attrs.fullName ??
      attrs.fullName2 ??
      (firstName || lastName
        ? [firstName, lastName].filter(Boolean).join(' ')
        : null);

    return {
      zimbraId: String(raw.id),
      firstName,
      lastName,
      fullName,
      nickname: attrs.nickname ?? null,
      company: attrs.company ?? null,
      jobTitle: attrs.jobTitle ?? null,
      emails,
      phones,
      notes: attrs.notes ?? null,
    };
  }

  /** Convert a flat ContactData object into the Zimbra attribute array format. */
  private dataToAttrs(data: ContactData): Array<{ n: string; _content: string }> {
    const attrs: Array<{ n: string; _content: string }> = [];
    const add = (n: string, v: string | undefined | null) => {
      if (v !== undefined && v !== null && v !== '') attrs.push({ n, _content: String(v) });
    };
    const fullName =
      data.fullName ??
      (data.firstName || data.lastName
        ? [data.firstName, data.lastName].filter(Boolean).join(' ')
        : undefined);
    add('firstName', data.firstName);
    add('lastName', data.lastName);
    add('fullName', fullName);
    add('nickname', data.nickname);
    add('company', data.company);
    add('jobTitle', data.jobTitle);
    add('email', data.email);
    add('email2', data.email2);
    add('email3', data.email3);
    add('workPhone', data.phone);
    add('mobilePhone', data.mobile);
    add('homePhone', data.homePhone);
    add('notes', data.notes);
    return attrs;
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
    const [personal, gal, history] = await Promise.all([
      this.zimbra.autoCompleteContacts(
        user.zimbraHost,
        user.authToken!,
        q,
        user.csrfToken ?? undefined,
      ),
      this.zimbra.searchGal(
        user.zimbraHost,
        user.authToken!,
        q,
        user.csrfToken ?? undefined,
      ),
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
    const rawContacts = await this.zimbra.getContacts(
      user.zimbraHost,
      user.authToken!,
      user.csrfToken ?? undefined,
    );

    for (const raw of rawContacts) {
      const parsed = this.parseZimbraContact(raw);
      if (!parsed.zimbraId) continue;

      await this.prisma.contact.upsert({
        where: { userId_zimbraId: { userId, zimbraId: parsed.zimbraId } },
        create: {
          userId,
          zimbraId: parsed.zimbraId,
          firstName: parsed.firstName,
          lastName:  parsed.lastName,
          fullName:  parsed.fullName,
          nickname:  parsed.nickname,
          company:   parsed.company,
          jobTitle:  parsed.jobTitle,
          emails:    parsed.emails as any,
          phones:    parsed.phones as any,
          notes:     parsed.notes,
          syncedAt:  new Date(),
        },
        update: {
          firstName: parsed.firstName,
          lastName:  parsed.lastName,
          fullName:  parsed.fullName,
          nickname:  parsed.nickname,
          company:   parsed.company,
          jobTitle:  parsed.jobTitle,
          emails:    parsed.emails as any,
          phones:    parsed.phones as any,
          notes:     parsed.notes,
          syncedAt:  new Date(),
        },
      });
    }
  }

  // ── Create ─────────────────────────────────────────────────────────────────

  async createContact(userId: string, data: ContactData): Promise<any> {
    const user = await this.getUser(userId);
    const attrs = this.dataToAttrs(data);
    const zimbraId = await this.zimbra.createContact(
      user.zimbraHost,
      user.authToken!,
      attrs,
      user.csrfToken ?? undefined,
    );

    const emails: Array<{ email: string; type: string; primary?: boolean }> = [];
    if (data.email)  emails.push({ email: data.email,  type: 'work',     primary: true });
    if (data.email2) emails.push({ email: data.email2, type: 'personal' });
    if (data.email3) emails.push({ email: data.email3, type: 'other' });

    const phones: Array<{ number: string; type: string }> = [];
    if (data.phone)     phones.push({ number: data.phone,     type: 'work' });
    if (data.mobile)    phones.push({ number: data.mobile,    type: 'mobile' });
    if (data.homePhone) phones.push({ number: data.homePhone, type: 'home' });

    const fullName =
      data.fullName ??
      (data.firstName || data.lastName
        ? [data.firstName, data.lastName].filter(Boolean).join(' ')
        : null);

    return this.prisma.contact.create({
      data: {
        userId,
        zimbraId,
        firstName: data.firstName ?? null,
        lastName:  data.lastName  ?? null,
        fullName,
        nickname:  data.nickname  ?? null,
        company:   data.company   ?? null,
        jobTitle:  data.jobTitle  ?? null,
        emails:    emails as any,
        phones:    phones as any,
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

    const attrs = this.dataToAttrs(data);
    await this.zimbra.modifyContact(
      user.zimbraHost,
      user.authToken!,
      contact.zimbraId,
      attrs,
      user.csrfToken ?? undefined,
    );

    const emails: Array<{ email: string; type: string; primary?: boolean }> = [];
    if (data.email)  emails.push({ email: data.email,  type: 'work',     primary: true });
    if (data.email2) emails.push({ email: data.email2, type: 'personal' });
    if (data.email3) emails.push({ email: data.email3, type: 'other' });

    const phones: Array<{ number: string; type: string }> = [];
    if (data.phone)     phones.push({ number: data.phone,     type: 'work' });
    if (data.mobile)    phones.push({ number: data.mobile,    type: 'mobile' });
    if (data.homePhone) phones.push({ number: data.homePhone, type: 'home' });

    const fullName =
      data.fullName ??
      (data.firstName || data.lastName
        ? [data.firstName, data.lastName].filter(Boolean).join(' ')
        : null);

    return this.prisma.contact.update({
      where: { id: contactId },
      data: {
        firstName: data.firstName ?? null,
        lastName:  data.lastName  ?? null,
        fullName,
        nickname:  data.nickname  ?? null,
        company:   data.company   ?? null,
        jobTitle:  data.jobTitle  ?? null,
        emails:    emails as any,
        phones:    phones as any,
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

    await this.zimbra.deleteContact(
      user.zimbraHost,
      user.authToken!,
      contact.zimbraId,
      user.csrfToken ?? undefined,
    );
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
