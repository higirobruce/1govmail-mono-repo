import type {
  ProviderFolder,
  ProviderMessage,
  ProviderContact,
  ProviderEvent,
  ProviderIdentity,
  ProviderSignature,
  ProviderAddress,
} from '../provider-types';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface MemoryMailbox {
  folders: ProviderFolder[];
  messages: ProviderMessage[];
  contacts: ProviderContact[];
  events: ProviderEvent[];
  identities: ProviderIdentity[];
  signatures: ProviderSignature[];
  prefs: Record<string, string>;
  attachments: Map<string, { filename: string; contentType: string; data: Buffer }>;
  password: string;
  displayName: string;
}

function displayNameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? email;
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Demo User';
}

/**
 * Deterministic seed for one in-memory mailbox. Every id is derived from a
 * plain counter so repeated calls with the same inputs produce byte-identical
 * output — no Math.random, no `new Date()` (all "current time" comes from the
 * injected `now`).
 */
export function seedMailbox(email: string, password: string, now: () => number): MemoryMailbox {
  const nowMs = now();
  const displayName = displayNameFromEmail(email);
  const self: ProviderAddress = { email, name: displayName };

  // ---- Folders ------------------------------------------------------------
  const nextFolderId = (kind: string) => `folder-${kind}`;

  const inboxId = nextFolderId('inbox');
  const sentId = nextFolderId('sent');
  const draftsId = nextFolderId('drafts');
  const trashId = nextFolderId('trash');
  const junkId = nextFolderId('junk');

  // ---- Contacts (seeded before messages so messages can reference them) ---
  const contactSeeds: Array<{ first: string; last: string; company: string; title: string }> = [
    { first: 'Alice', last: 'Uwimana', company: 'Ministry of ICT', title: 'Director' },
    { first: 'Bosco', last: 'Nkurunziza', company: 'RISA', title: 'Program Manager' },
    { first: 'Claudine', last: 'Mukamana', company: 'Ministry of Finance', title: 'Analyst' },
    { first: 'David', last: 'Habimana', company: 'RISA', title: 'Systems Engineer' },
    { first: 'Esperance', last: 'Ingabire', company: 'Ministry of Health', title: 'Coordinator' },
    { first: 'Fabrice', last: 'Niyonsenga', company: 'RISA', title: 'DevOps Lead' },
    { first: 'Grace', last: 'Umutoni', company: 'Ministry of Education', title: 'Advisor' },
    { first: 'Hakizimana', last: 'Jean', company: 'RISA', title: 'Support Specialist' },
    { first: 'Immaculee', last: 'Nyirahabimana', company: 'Ministry of Justice', title: 'Legal Officer' },
    { first: 'Jules', last: 'Rugamba', company: 'RISA', title: 'Solutions Architect' },
  ];

  const contacts: ProviderContact[] = contactSeeds.map((c, i) => {
    const n = i + 1;
    const localPart = `${c.first}.${c.last}`.toLowerCase().replace(/[^a-z.]/g, '');
    const contactEmail = `${localPart}@example.gov.rw`;
    return {
      id: `contact-${n}`,
      displayName: `${c.first} ${c.last}`,
      firstName: c.first,
      lastName: c.last,
      nickname: null,
      company: c.company,
      jobTitle: c.title,
      emails: [{ email: contactEmail, type: 'work', primary: true }],
      phones: [{ number: `+25078${(1000000 + n).toString().slice(-7)}`, type: 'mobile' }],
      notes: null,
    };
  });

  // ---- Messages -------------------------------------------------------------
  const conversationCount = 4;
  const conversationIds = Array.from({ length: conversationCount }, (_, i) => `conv-${i + 1}`);

  const messages: ProviderMessage[] = [];
  const attachments = new Map<string, { filename: string; contentType: string; data: Buffer }>();

  const totalMessages = 30;
  const unreadTarget = 8;
  const flaggedTarget = 2;
  const attachmentMessageIndex = 12; // 1-based position among all messages, deterministic
  const sentMessageCount = 6; // last N messages live in Sent

  for (let i = 1; i <= totalMessages; i++) {
    const id = `msg-${i}`;
    const isSent = i > totalMessages - sentMessageCount;
    const folderId = isSent ? sentId : inboxId;
    const contact = contacts[(i - 1) % contacts.length];
    const contactEmail = contact.emails[0].email;
    const conversationId = conversationIds[(i - 1) % conversationIds.length];

    const from: ProviderAddress = isSent ? self : { email: contactEmail, name: contact.displayName ?? undefined };
    const to: ProviderAddress[] = isSent ? [{ email: contactEmail, name: contact.displayName ?? undefined }] : [self];

    // Spread receivedAt over the last ~10 days, most recent = highest i.
    const daysAgo = ((totalMessages - i) % 10) + (i % 3) * 0.1;
    const receivedAt = new Date(nowMs - daysAgo * DAY_MS);

    const isRead = i > unreadTarget; // first `unreadTarget` messages are unread
    const isFlagged = i % Math.ceil(totalMessages / flaggedTarget) === 0;
    const hasAttachments = i === attachmentMessageIndex;

    let attachmentData: Buffer | undefined;
    if (hasAttachments) {
      attachmentData = Buffer.from(`Seeded attachment for message ${id}.\n`, 'utf-8');
      attachments.set(id, {
        filename: 'notes.txt',
        contentType: 'text/plain',
        data: attachmentData,
      });
    }

    messages.push({
      id,
      conversationId,
      folderId,
      subject: isSent ? `Re: Follow-up ${conversationId}` : `${conversationId} update #${i}`,
      snippet: `This is a seeded ${isSent ? 'sent' : 'received'} message for demo purposes (#${i}).`,
      from,
      to,
      cc: [],
      bcc: [],
      receivedAt,
      size: 1024 + i * 37,
      isRead,
      isFlagged,
      hasAttachments,
      isDraft: false,
      tags: [],
      bodyHtml: `<p>This is a seeded ${isSent ? 'sent' : 'received'} message body for message #${i}.</p>`,
      bodyText: `This is a seeded ${isSent ? 'sent' : 'received'} message body for message #${i}.`,
      attachments: hasAttachments
        ? [
            {
              part: '2',
              filename: 'notes.txt',
              contentType: 'text/plain',
              size: attachmentData!.length,
              isInline: false,
            },
          ]
        : [],
    });
  }

  // One draft, for completeness of the settings/mail surface.
  messages.push({
    id: 'msg-draft-1',
    conversationId: null,
    folderId: draftsId,
    subject: '(Draft) Quarterly report',
    snippet: 'Draft in progress — quarterly report outline...',
    from: self,
    to: [],
    cc: [],
    bcc: [],
    receivedAt: new Date(nowMs - 1 * DAY_MS),
    size: 512,
    isRead: true,
    isFlagged: false,
    hasAttachments: false,
    isDraft: true,
    tags: [],
    bodyHtml: '<p>Draft in progress...</p>',
    bodyText: 'Draft in progress...',
    attachments: [],
  });

  const countFor = (folderId: string) => {
    const inFolder = messages.filter((m) => m.folderId === folderId);
    return { total: inFolder.length, unread: inFolder.filter((m) => !m.isRead).length };
  };

  const inboxCounts = countFor(inboxId);
  const sentCounts = countFor(sentId);
  const draftsCounts = countFor(draftsId);
  const trashCounts = countFor(trashId);
  const junkCounts = countFor(junkId);

  const folders: ProviderFolder[] = [
    { id: inboxId, name: 'Inbox', path: '/Inbox', type: 'inbox', kind: 'mail', unreadCount: inboxCounts.unread, totalCount: inboxCounts.total, parentId: undefined },
    { id: sentId, name: 'Sent', path: '/Sent', type: 'sent', kind: 'mail', unreadCount: sentCounts.unread, totalCount: sentCounts.total, parentId: undefined },
    { id: draftsId, name: 'Drafts', path: '/Drafts', type: 'drafts', kind: 'mail', unreadCount: draftsCounts.unread, totalCount: draftsCounts.total, parentId: undefined },
    { id: trashId, name: 'Trash', path: '/Trash', type: 'trash', kind: 'mail', unreadCount: trashCounts.unread, totalCount: trashCounts.total, parentId: undefined },
    { id: junkId, name: 'Junk', path: '/Junk', type: 'junk', kind: 'mail', unreadCount: junkCounts.unread, totalCount: junkCounts.total, parentId: undefined },
  ];

  // ---- Events -------------------------------------------------------------
  const eventCount = 5;
  const events: ProviderEvent[] = Array.from({ length: eventCount }, (_, idx) => {
    const n = idx + 1;
    // Spread across -3..+3 days from now, well within the ±7 day window.
    const offsetDays = idx - Math.floor(eventCount / 2);
    const startAt = new Date(nowMs + offsetDays * DAY_MS);
    const endAt = new Date(startAt.getTime() + 60 * 60 * 1000);
    const contact = contacts[idx % contacts.length];
    return {
      id: `event-${n}`,
      title: `Meeting ${n} with ${contact.displayName}`,
      location: n % 2 === 0 ? 'Conference Room A' : null,
      startAt,
      endAt,
      allDay: false,
      description: `Seeded calendar event #${n}.`,
      organizer: self,
      attendees: [],
      inviteId: null,
      isRecurring: n === eventCount, // last one marked recurring
    };
  });

  // ---- Identities / signatures / prefs -------------------------------------
  const identities: ProviderIdentity[] = [
    {
      id: 'ident-1',
      name: displayName,
      attrs: {
        zimbraPrefFromDisplay: displayName,
        zimbraPrefFromAddress: email,
      },
    },
  ];

  const signatures: ProviderSignature[] = [
    {
      id: 'sig-1',
      name: 'Default',
      contentHtml: `<p>-- <br/>${displayName}</p>`,
      contentText: `--\n${displayName}`,
    },
  ];

  const prefs: Record<string, string> = {
    zimbraPrefGroupMailBy: 'conversation',
    zimbraPrefMailSignatureStyle: 'outlook',
    zimbraPrefComposeFormat: 'html',
    zimbraPrefDefaultSignatureId: 'sig-1',
  };

  return {
    folders,
    messages,
    contacts,
    events,
    identities,
    signatures,
    prefs,
    attachments,
    password,
    displayName,
  };
}
