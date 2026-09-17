import { BadRequestException, Injectable, NotFoundException, Logger, UnauthorizedException, ConflictException } from '@nestjs/common';
import { deriveLabel, formatAttachments, isSpamFolderPath, mdToHtml, type ExtractedCard, type TriageLabel } from '@email-client/shared';
import { PrismaService } from '../prisma/prisma.service';
import { MailProviderResolver } from '../provider/mail-provider.resolver';
import { MailSessionUser, buildMailSession } from '../provider/mail-session';
import { ProviderAttachmentMeta, ProviderFolderKind } from '../provider/provider-types';
import { NotificationsService } from '../notifications/notifications.service';
import { TasksService } from '../tasks/tasks.service';
import { matchSenderRule, type SenderRuleLike } from './sender-rule-matcher';
import { PromoteCommitmentDto } from './dto/promote-commitment.dto';
import { inlineSignatureImages } from '../common/signature-images';
import { MailSearchFilter, isEmptyFilter } from '../provider/mail-search-filter';
import { ProviderMessage, ProviderMessagePage } from '../provider/provider-types';
import { InlineImageCacheService } from './inline-image-cache.service';

const CARD_WINDOWS = ['today', '24h', 'week'] as const;
type CardWindow = (typeof CARD_WINDOWS)[number];
const CARD_FOLDER_PATHS = ['/Inbox', '/Sent'];
const MAX_CARD_IDS = 100;
const MAX_WINDOW_CARDS = 50;
const MAX_COMMITMENTS = 200;
const COMMITMENT_STATUS_FILTERS = ['open', 'archived'] as const;
type CommitmentStatusFilter = (typeof COMMITMENT_STATUS_FILTERS)[number];
const COMMITMENT_UPDATE_STATUSES = ['done', 'dismissed', 'open'] as const;
type CommitmentUpdateStatus = (typeof COMMITMENT_UPDATE_STATUSES)[number];

/**
 * What `notifyNewMail` tells the folder-persist loop that runs after it.
 *
 * `inboxUnreadOwnedFor` is the PROVIDER folder id whose stored `unreadCount`
 * the notification path has taken responsibility for this cycle. The loop must
 * leave that ONE column on that ONE row alone — every other column of that
 * row, and every other folder, persists exactly as before.
 *
 * It exists because the loop used to write `unreadCount` for every folder
 * unconditionally, which silently undid the transaction wrapping the claim and
 * the insert: when those rolled back together, the loop advanced the baseline
 * anyway, the next sync saw no delta, and the arrival was announced nowhere.
 * `null` means the loop owns every count, as it always did.
 */
interface InboxBaselineOwnership {
  inboxUnreadOwnedFor: string | null;
}

export interface CommitmentRow {
  id: string;
  conversationId: string | null;
  messageId: string;
  type: string;
  text: string;
  dueHint: string | null;
  status: string;
  suggestResolve: boolean;
  hintMessageId: string | null;
  taskId: string | null;
  extractedAt: Date;
  lastActivityAt: Date;
  resolvedAt: Date | null;
}

export interface CommitmentDto extends CommitmentRow {
  counterparty: string | null;
}

interface WindowCardRow {
  messageId: string;
  gist: string;
  asksOfMe: unknown;
  deadlines: unknown;
  commitmentsIMade: unknown;
  waitingOn: string | null;
  importance: string;
  injectionSuspected: boolean;
  message: {
    conversationId: string | null;
    subject: string | null;
    fromEmail: string;
    fromName: string | null;
    receivedAt: Date;
    attachments: unknown;
    folder: { path: string };
  };
}


/**
 * Metadata-only column set for message rows returned to a list view (folder
 * listing and search results). Bodies are deliberately excluded: `bodyHtml`
 * with embedded base64 inline images, multiplied by a 50-row page, produces a
 * response big enough to stall JSON.stringify (V8 string-length limit) and to
 * take seconds to ship to the client.
 */
const MESSAGE_LIST_SELECT = {
  id: true,
  userId: true,
  folderId: true,
  zimbraId: true,
  conversationId: true,
  subject: true,
  snippet: true,
  fromEmail: true,
  fromName: true,
  toRecipients: true,
  ccRecipients: true,
  bccRecipients: true,
  replyTo: true,
  isRead: true,
  isStarred: true,
  isDraft: true,
  hasAttachments: true,
  flags: true,
  tags: true,
  sentAt: true,
  receivedAt: true,
  syncedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Provider addresses → the `{email, name}` JSON shape the DB columns hold. */
function mapAddresses(
  list: { email: string; name?: string | null }[] | undefined,
): { email: string; name: string | null }[] {
  return (list ?? []).map((a) => ({ email: a.email, name: a.name ?? null }));
}

/**
 * Recipient fields for an upsert's `update` half.
 *
 * Recipients are refreshed on update (not written once on insert) so a row
 * first synced without them — a pre-`recip=2` Zimbra sync, or an EWS FindItem
 * that returns no recipient properties — heals on the next folder load instead
 * of showing no "To" forever.
 *
 * The refresh is deliberately one-directional: a field is emitted ONLY when the
 * provider actually returned addresses for it. A payload carrying no recipient
 * roles must never blank out a full list that a message open already stored —
 * the same erase-on-resync trap that cost icalUid its value in 630d28e.
 */
function recipientRefresh(m: ProviderMessage): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (m.to?.length)  out.toRecipients  = mapAddresses(m.to);
  if (m.cc?.length)  out.ccRecipients  = mapAddresses(m.cc);
  if (m.bcc?.length) out.bccRecipients = mapAddresses(m.bcc);
  return out;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: MailProviderResolver,
    private readonly notifications: NotificationsService,
    private readonly tasksService: TasksService,
    private readonly inlineCache: InlineImageCacheService = new InlineImageCacheService(),
  ) {}

  private async getUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    // No Zimbra token means user hasn't logged in via Zimbra yet (or token was
    // cleared after expiry). Return 401 so the frontend redirects to /login.
    if (!user.authToken) throw new UnauthorizedException('Please log in again to connect to Zimbra.');

    // Proactively detect Zimbra token expiry before making any SOAP call.
    // Clear the stale token so the next login will always fetch a fresh one.
    if (user.tokenExpiry && user.tokenExpiry <= new Date()) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { authToken: null, tokenExpiry: null },
      });
      throw new UnauthorizedException('Your Zimbra session has expired. Please log in again.');
    }

    return user;
  }

  /** Neutral folder content class → this app's FolderType enum. The provider's
   *  own content-class vocabulary never reaches here (see
   *  ZIMBRA_VIEW_TO_KIND); an absent kind means "the provider did not say",
   *  which is mail. */
  private folderKindToType(
    kind?: ProviderFolderKind,
  ): 'MAIL' | 'CONTACTS' | 'CALENDAR' | 'TASKS' | 'BRIEFCASE' {
    switch (kind) {
      case 'contacts':  return 'CONTACTS';
      case 'calendar':  return 'CALENDAR';
      case 'tasks':     return 'TASKS';
      case 'documents': return 'BRIEFCASE';
      default:          return 'MAIL';
    }
  }

  async getFolders(userId: string) {
    const user = await this.getUser(userId);

    let providerFolders;
    try {
      providerFolders = await this.resolver.forUser(user).getFolders(buildMailSession(user));
    } catch (err: any) {
      // If Zimbra rejects the token (expired or revoked), clear it so the
      // next login is forced to fetch a fresh one, then propagate the 401.
      if (err instanceof UnauthorizedException) {
        await this.prisma.user.update({
          where: { id: userId },
          data: { authToken: null, tokenExpiry: null },
        });
      }
      throw err;
    }

    // Which folder's stored unreadCount the notification path owns for this
    // cycle (see InboxBaselineOwnership). The loop below must not write that
    // one column on that one row: doing so is what used to undo the claim's
    // transaction on rollback, advancing the baseline with nothing announced.
    const { inboxUnreadOwnedFor } = await this.notifyNewMail(userId, providerFolders);

    // Persist folders to DB for caching; failures here must not prevent the
    // response from reaching the client (don't let a Prisma error become 500).
    const saved: any[] = [];
    for (const f of providerFolders) {
      try {
        const folderType = this.folderKindToType(f.kind);
        // The Inbox baseline is notifyNewMail's to move when it claimed the
        // transition (it wrote the same value), declined to (nothing changed),
        // or failed (the claim rolled back and must be retried next sync).
        // Everything else about the upsert is unchanged — including the
        // `create` branch, which always seeds the count, because a row that
        // does not exist yet holds no baseline to protect.
        const ownsUnread = f.id === inboxUnreadOwnedFor;
        const folder = await this.prisma.folder.upsert({
          where: { userId_zimbraId: { userId, zimbraId: f.id } },
          update: {
            name: f.name,
            path: f.path,
            type: folderType,
            ...(ownsUnread ? {} : { unreadCount: f.unreadCount }),
            totalCount: f.totalCount,
            syncedAt: new Date(),
          },
          create: {
            userId,
            zimbraId: f.id,
            name: f.name,
            path: f.path,
            type: folderType,
            parentId: f.parentId ?? null,
            unreadCount: f.unreadCount,
            totalCount: f.totalCount,
            syncedAt: new Date(),
          },
        });
        saved.push(folder);
      } catch (err: any) {
        // Log but keep processing remaining folders
        this.logger.error(
          `Failed to upsert folder zimbraId=${f.id} name="${f.name}": ${err?.message}`,
        );
      }
    }

    return saved;
  }

  /**
   * How many times one sync will re-read the baseline and retry its claim when
   * a concurrent sync moved the baseline out from under it.
   *
   * A zero from the claim means "someone moved that baseline", NOT "someone
   * announced what I measured" — the winner may have claimed a smaller
   * transition than this sync measured, leaving its extra messages in no
   * announcement at all. So a loser re-reads and tries again while the
   * baseline is still below its own measurement. Bounded, because this runs
   * inside every folder sync and under-announcing one arrival is far cheaper
   * than a loop that never returns.
   */
  private static readonly NEW_MAIL_CLAIM_ATTEMPTS = 3;

  /**
   * Raise a NEW_MAIL notification when the Inbox unread count has RISEN since
   * the last sync. A fall means the user read mail somewhere else, which is
   * not an arrival.
   *
   * Reads the stored Inbox row itself (this must happen BEFORE the upsert loop
   * in getFolders overwrites it — that read used to live in getFolders,
   * unguarded; it now lives here so its failure is covered by the same
   * try/catch as the claim below). Never throws: a failed read or a failed
   * claim degrades to the same outcome as "no previous row" — skip the
   * notification, log at WARN, and let the folder list continue. An alert is
   * worth less than the folder list this runs inside.
   *
   * Returns which folder's stored `unreadCount` it owns for this cycle, which
   * the persist loop then leaves alone (see InboxBaselineOwnership). This path
   * owns that column from the moment it has read a baseline: it is the only
   * thing that knows whether the value in the row is a claim to keep, a
   * rolled-back claim to retry, or a count to lower.
   */
  private async notifyNewMail(
    userId: string,
    fetched: Array<{ id: string; path: string; unreadCount: number }>,
  ): Promise<InboxBaselineOwnership> {
    // Held OUTSIDE the try so a FAILURE can report ownership too. A claim that
    // rolled back has left the baseline where it was on purpose, so the next
    // sync measures the same delta and announces it; if the persist loop
    // advanced the baseline anyway, that arrival would be announced nowhere —
    // the identical loss the transaction was added to prevent, reached through
    // the loop instead of through a crash.
    let inboxProviderId: string | null = null;
    try {
      // Resolve the PROVIDER's inbox first, because its id is what identifies
      // the row to read.
      const current = fetched.find((f) => f.path === '/Inbox');
      if (!current) return { inboxUnreadOwnedFor: null };
      inboxProviderId = current.id;

      // Resolved at most ONCE per sync, not once per attempt: both its inputs
      // — the stored row's identity and the count this sync measured — are the
      // same on every pass, so a retry that re-ran it would pay for another
      // indexed query to rebuild a string it already has.
      let body: string | undefined;

      for (let attempt = 0; attempt < MailService.NEW_MAIL_CLAIM_ATTEMPTS; attempt += 1) {
        // Read the baseline by the SAME identity the persist loop writes by.
        //
        // `path` is not unique. (userId, zimbraId) is the folders table's only
        // unique key, the upsert loop writes by it, and nothing prunes rows the
        // provider has stopped returning — so one user can hold TWO rows both
        // stamped '/Inbox'. Flipping an Institution.provider from zimbra to
        // exchange keeps the same User row (auth upserts on email) while EWS
        // returns different folder ids that also map to '/Inbox'; so does a
        // Demo/local login on a real address, a restored mailbox, and
        // renameFolder, which rewrites `path` to `/${name}` unconditionally.
        //
        // The stale row is never upserted again, so its count is FROZEN — and
        // being the older row it is the likely result of an unordered
        // `findFirst`. Measuring against it computes a negative delta on every
        // sync forever: no chime, no toast, no row, indefinitely. Reading by
        // the unique key reads the row that gets written, so which ROW this
        // measures against is no longer ambiguous. (`orderBy: { syncedAt:
        // 'desc' }` would only pick the freshest duplicate and leave the
        // ambiguity in place.)
        //
        // Which FOLDER is the inbox was a separate ambiguity, and it lived
        // upstream of here: on EWS the whole tree arrives flat and any folder
        // merely NAMED 'Inbox' used to carry the path '/Inbox', so the `find`
        // above could pick `Archive/Inbox` and then compare that folder's own
        // row against itself forever. It is fixed where it was created —
        // EwsService.mapFolder grants a canonical system path only to a
        // folder whose parent is the mail root — so the `find` resolves one
        // folder, and this stays a lookup rather than a guess.
        const previous = await this.prisma.folder.findUnique({
          where: { userId_zimbraId: { userId, zimbraId: current.id } },
          select: { id: true, unreadCount: true },
        });
        // No row for the provider's inbox yet: the first sync of a mailbox, or
        // the first sync after the provider started issuing new folder ids. The
        // upsert loop below creates it with the count just fetched, so the next
        // sync has a baseline. Nothing to announce, nothing to claim — and
        // nothing to own: the loop must be free to seed the row.
        if (!previous) return { inboxUnreadOwnedFor: null };

        const delta = current.unreadCount - previous.unreadCount;
        // Nothing changed, so there is nothing for ANYONE to write. This is
        // also what closes the rewind the fourth wave documented and left
        // open: a sync holding a fetch that predates an arrival used to upsert
        // its older count over a baseline another sync had just claimed.
        if (delta === 0) return { inboxUnreadOwnedFor: inboxProviderId };
        if (delta < 0) {
          // The user read mail elsewhere. Not an arrival — but the baseline
          // must still FALL, or it becomes a high-water mark and a user who
          // once reached 50 unread hears nothing until they pass 50 again.
          //
          // Conditional on the value this sync actually read, for the same
          // reason the claim is: if another sync moved the baseline in
          // between, that sync's count is the fresher one and this write must
          // not rewind it. A no-match needs no retry — the next sync re-reads
          // and lowers if a fall is still owed.
          await this.prisma.folder.updateMany({
            where: { id: previous.id, unreadCount: previous.unreadCount },
            data: { unreadCount: current.unreadCount },
          });
          return { inboxUnreadOwnedFor: inboxProviderId };
        }

        // Resolved BEFORE the transaction opens: it is a second query, and
        // holding a transaction open across it on a per-sync path buys nothing.
        body ??= await this.newMailBody(userId, previous.id, current.unreadCount);

        // Claim the transition by ADVANCING THE BASELINE CONDITIONALLY.
        //
        // The decision and the write are one operation: move the stored Inbox
        // count off the exact value this sync measured from, and announce only
        // if that update matched a row. Whoever matches owns the arrival;
        // everyone else finds the baseline already gone.
        //
        // The claim and the insert share ONE transaction. Apart, a crash
        // between them loses the arrival outright: the baseline has moved, so
        // the next sync sees no delta, and no row exists to show for it.
        //
        // Three timing-based guards were tried here before this one, and each
        // lost real mail:
        //
        // - A clock window ("did we notify in the last 60s?") suppresses
        //   whatever lands inside it, and the baseline advances whether or not
        //   anything was announced, so a suppressed arrival is gone for good.
        // - The level alone ("is the count higher than the last announced
        //   one?") turns the announced count into a high-water mark that never
        //   falls: a user who reaches 50 unread and clears the inbox hears
        //   nothing until they pass 50 again.
        // - The transition plus a short window has the same hole as the first,
        //   only narrower. There is no window that is safe, because there is no
        //   floor on how fast a baseline can legitimately return: the sidebar
        //   polls folders every 60s on every non-mail page, the mail page syncs
        //   on mount, and useInboxSync fires 10s after mount — a complete
        //   notify -> read -> refill cycle fits inside seconds.
        //
        // The database answers the question none of them could: not "does this
        // look like something we already said?" but "is this sync the one that
        // moved the mailbox off that baseline?".
        const claimed = await this.prisma.$transaction(async (tx) => {
          const advanced = await tx.folder.updateMany({
            where: { id: previous.id, unreadCount: previous.unreadCount },
            data: { unreadCount: current.unreadCount },
          });
          if (advanced.count === 0) return false;

          await this.notifications.createNotification(
            userId,
            'NEW_MAIL',
            `${delta} new message${delta === 1 ? '' : 's'}`,
            body,
            '/mail',
            // Recorded for debugging only — what the delta was measured from,
            // what was announced, and the difference. Nothing compares these
            // across rows; the claim above is the whole decision.
            { baseline: previous.unreadCount, unreadCount: current.unreadCount, delta },
            tx,
          );
          return true;
        });

        if (claimed) return { inboxUnreadOwnedFor: inboxProviderId };
        // Lost the claim. Loop round: re-read the baseline, and retry while it
        // is still below the count THIS sync measured. If the winner already
        // took the baseline to (or past) that count, the delta comes out <= 0
        // and the loop returns on the next pass.
      }
      // Out of attempts. The baseline is whatever the winning syncs left it
      // at, which is never this sync's to overwrite.
      return { inboxUnreadOwnedFor: inboxProviderId };
    } catch (err: any) {
      this.logger.warn(`NEW_MAIL notification failed for userId=${userId}: ${err?.message}`);
      return { inboxUnreadOwnedFor: inboxProviderId };
    }
  }

  /**
   * What the toast and the OS notification actually read: the sender and
   * subject of the newest unread Inbox message when the DB already holds it,
   * and the unread total when it does not (a mailbox synced only at folder
   * level, or a message that has not been pulled yet).
   *
   * One indexed lookup on the (userId, folderId) index, on a per-sync path.
   * Never throws — a body is not worth losing the notification over.
   */
  private async newMailBody(userId: string, inboxFolderId: string, unreadCount: number): Promise<string> {
    const fallback = `Inbox now has ${unreadCount} unread`;
    try {
      const newest = await this.prisma.message.findFirst({
        where: { userId, folderId: inboxFolderId, isRead: false },
        orderBy: { receivedAt: 'desc' },
        select: { fromName: true, fromEmail: true, subject: true },
      });
      if (!newest) return fallback;

      const sender = newest.fromName?.trim() || newest.fromEmail;
      const subject = newest.subject?.trim() || '(no subject)';
      return `${sender} — ${subject}`;
    } catch (err: any) {
      this.logger.warn(
        `Could not read the newest unread Inbox message for userId=${userId}: ${err?.message}`,
      );
      return fallback;
    }
  }

  // `rules` and `junkFolder` are resolved once per `getMessages` call (see the
  // caller) rather than fetched here — this method used to re-query both on
  // every single message, which meant ~50 serialized Postgres queries (plus a
  // Zimbra SOAP call per match) added to every folder-open, for every user,
  // whether or not they use this feature at all.
  // Public: called by SenderRuleSweepService, which owns rule enforcement now
  // that it no longer runs inside the Inbox list GET.
  async enforceSenderRules(
    userId: string,
    user: MailSessionUser,
    message: { id: string; zimbraId: string; fromEmail: string; folderId: string },
    rules: SenderRuleLike[],
    junkFolder: { id: string; zimbraId: string } | null,
  ): Promise<void> {
    if (matchSenderRule(message.fromEmail, rules) !== 'BLOCK') return;

    const currentFolder = await this.prisma.folder.findFirst({ where: { userId, id: message.folderId } });
    if (isSpamFolderPath(currentFolder?.path)) return;

    if (!junkFolder) {
      this.logger.warn(
        `Sender rule BLOCK matched for message id=${message.id} (userId=${userId}) but no /Junk or /Spam folder is synced for this account — skipping auto-file.`,
      );
      return;
    }

    await this.resolver
      .forUser(user)
      .moveMessage(buildMailSession(user), message.zimbraId, junkFolder.zimbraId);
    await this.prisma.message.update({ where: { id: message.id }, data: { folderId: junkFolder.id } });
  }

  async getMessages(userId: string, folderId: string, limit = 50, offset = 0) {
    const user = await this.getUser(userId);

    const folder = await this.prisma.folder.findFirst({
      where: { userId, id: folderId },
    });
    if (!folder) throw new NotFoundException('Folder not found');

    const { messages, total, more } = await this.resolver.forUser(user).getMessages(
      buildMailSession(user),
      folder.zimbraId,
      limit,
      offset,
    );

    const results = await Promise.allSettled(
      messages.map((m) => {
        const zimbraId = m.id;

        return this.prisma.message.upsert({
          where: { userId_zimbraId: { userId, zimbraId } },
          update: {
            // conversationId is refreshed (not just set on insert) so a row that
            // was synced before the provider populated a grouping key — e.g. every
            // EWS row synced before ConversationTopic mapping existed — heals to a
            // real thread key on the next folder load instead of staying null and
            // stranded on the single-message layout. It is stable for a given
            // message, so re-writing it is idempotent for the Zimbra path.
            conversationId: m.conversationId,
            isRead:    m.isRead,
            isStarred: m.isFlagged,
            isDraft:   m.isDraft,
            syncedAt:  new Date(),
            ...recipientRefresh(m),
          },
          create: {
            userId,
            folderId,
            zimbraId,
            conversationId: m.conversationId,
            subject:        m.subject,
            snippet:        m.snippet,
            fromEmail:      m.from.email,
            fromName:       m.from.name ?? null,
            toRecipients:   mapAddresses(m.to),
            ccRecipients:   mapAddresses(m.cc),
            bccRecipients:  mapAddresses(m.bcc),
            isRead:         m.isRead,
            isStarred:      m.isFlagged,
            isDraft:        m.isDraft,
            hasAttachments: m.hasAttachments,
            receivedAt:     m.receivedAt,
          },
          select: MESSAGE_LIST_SELECT,
        });
      }),
    );

    const saved: any[] = [];
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        saved.push(result.value);
      } else {
        this.logger.error(`Failed to upsert message zimbraId=${messages[i].id}: ${result.reason?.message}`);
      }
    });

    // Sender-rule enforcement deliberately does NOT run here: a mutating SOAP
    // call in a read path cost rule-owning users up to 50 serial Zimbra moves
    // of latency per Inbox load. SenderRuleSweepService enforces the same
    // rules each minute against the rows this read-through cache just synced.

    return {
      messages: saved,
      total,
      offset,
      limit,
      hasMore: more,
    };
  }

  async getMessage(userId: string, messageId: string) {
    const user = await this.getUser(userId);

    const cached = await this.prisma.message.findFirst({
      where: { userId, id: messageId },
    });

    // Return cache when: body exists, attachments are stored, inlineImages is not null
    // (null = never fetched). A cid: reference in bodyHtml is now the NORMAL resting
    // state — inline images are served from the inline-image cache (see
    // InlineImageCacheService / getInlineImage) instead of being embedded as base64,
    // so a leftover cid: must NOT force a refetch here. Doing so would mean every
    // single open re-fetches from the provider forever, since bodies are never
    // embedded anymore. An un-proxied Zimbra-hosted image URL is a different problem
    // and still forces a refetch.
    const attachmentsCached = Array.isArray(cached?.attachments) && (cached.attachments as any[]).length >= 0;
    const bodyHasZimbraUrls = (cached?.bodyHtml ?? '').includes('/service/home/');
    if ((cached?.bodyHtml || cached?.bodyText) && attachmentsCached && cached?.inlineImages !== null && !bodyHasZimbraUrls) {
      return cached;
    }

    const session = buildMailSession(user);
    const m = await this.resolver.forUser(user).getMessage(session, cached?.zimbraId ?? messageId);

    // Stored and returned as-is — cid: refs intact, nothing embedded. The client
    // resolves them via the inline-image cache route.
    const bodyHtml     = m.bodyHtml ?? null;
    const bodyText     = m.bodyText ?? null;
    const attachments  = this.toStoredAttachments(m.attachments);
    const inlineImages = this.toStoredInlineImages(m.attachments);

    // Full recipient info — the list/search sync only carries To.
    const ccRecipients  = m.cc.map((a) => ({ email: a.email, name: a.name ?? null }));
    // Bcc is only visible on the user's own sent/draft items.
    const bccRecipients = m.bcc.map((a) => ({ email: a.email, name: a.name ?? null }));

    let result: any;
    if (cached) {
      result = await this.prisma.message.update({
        where: { id: cached.id },
        // GetMsg is the authoritative fetch, so it heals recipients a
        // metadata-only list sync could not populate — To included.
        data: {
          bodyHtml, bodyText, attachments, inlineImages,
          hasAttachments: attachments.length > 0,
          toRecipients: mapAddresses(m.to), ccRecipients, bccRecipients,
        },
      });
    } else {
      // Message is not in DB yet (e.g. opened from search results before the folder
      // was synced). Attempt to upsert so that subsequent opens are served from cache.
      const folder = await this.prisma.folder.findFirst({ where: { userId, zimbraId: m.folderId } });

      if (folder) {
        result = await this.prisma.message.upsert({
          where:  { userId_zimbraId: { userId, zimbraId: m.id } },
          create: {
            userId,
            folderId:       folder.id,
            zimbraId:       m.id,
            subject:        m.subject,
            snippet:        null,
            fromEmail:      m.from.email,
            fromName:       m.from.name ?? null,
            toRecipients:   mapAddresses(m.to),
            ccRecipients,
            bccRecipients,
            isRead:         m.isRead,
            isStarred:      m.isFlagged,
            isDraft:        m.isDraft,
            hasAttachments: attachments.length > 0,
            attachments,
            inlineImages,
            bodyHtml,
            bodyText,
            receivedAt:     m.receivedAt,
          },
          update: {
            bodyHtml,
            bodyText,
            attachments,
            inlineImages,
            hasAttachments: attachments.length > 0,
            ccRecipients,
            bccRecipients,
          },
        });
      } else {
        // Folder not yet synced — return ephemeral object (no caching possible).
        result = { bodyHtml, bodyText, attachments, inlineImages, hasAttachments: attachments.length > 0, ccRecipients, bccRecipients };
      }
    }

    return result;
  }

  /**
   * Returns all messages in the same conversation as the given messageId,
   * ordered oldest → newest.  Body fields are omitted — callers fetch bodies
   * lazily via getMessage() when the user expands a message.
   */
  async getConversation(userId: string, messageId: string) {
    // Resolve the message to get conversationId
    const msg = await this.prisma.message.findFirst({
      where: { userId, id: messageId },
      select: { id: true, conversationId: true },
    });

    if (!msg) throw new NotFoundException('Message not found');

    // Standalone message — no conversation
    if (!msg.conversationId) {
      return { conversationId: null, messages: [] };
    }

    // Back-fill conversation messages not yet in the local DB by querying the
    // provider. This ensures the full thread history is visible when a user was
    // CC'd mid-thread or when older messages haven't been reached by the
    // incremental folder sync yet.
    //
    // The back-fill uses the `conv:<id>` search syntax, which is Zimbra's — an
    // Exchange (EWS) backend rejects/ignores it as a plain AQS query, so we gate
    // on provider. EWS derives conversationId from the ConversationTopic extended
    // property (FindItem never returns the strongly-typed ConversationId), and
    // stamps it on every folder-synced row, so the local group-by below is
    // already complete for EWS without a back-fill; sending it a malformed
    // `conv:` query would be wrong, not merely useless.
    try {
      const user = await this.getUser(userId);

      if (user.provider === 'zimbra') {
        // Find zimbraIds already in the DB for this conversation to avoid re-fetching
        const existing = await this.prisma.message.findMany({
          where: { userId, conversationId: msg.conversationId },
          select: { zimbraId: true },
        });
        const existingZimbraIds = new Set(existing.map((m) => m.zimbraId));

        const { messages: threadMsgs } = await this.resolver.forUser(user).searchMessages(
          buildMailSession(user),
          `conv:${msg.conversationId}`,
          200,
          0,
        );

        // Build a folder zimbraId → DB folder map so we avoid per-message DB lookups
        const folders = await this.prisma.folder.findMany({
          where: { userId },
          select: { id: true, zimbraId: true },
        });
        const folderByZimbraId = new Map(folders.map((f) => [f.zimbraId, f.id]));

        // Collect the missing rows and insert them in ONE batched write — a
        // 20-message thread used to cost 20 serial upsert round-trips inside the
        // open-thread request. skipDuplicates covers the race where a row appears
        // between the existing-ids read and this insert (the old upsert's only
        // remaining job, since already-synced ids are filtered out above).
        const rows = threadMsgs.flatMap((m) => {
          if (existingZimbraIds.has(m.id)) return []; // already synced

          const folderId = folderByZimbraId.get(m.folderId);
          if (!folderId) return []; // folder not yet synced — skip

          return [{
            userId,
            folderId,
            zimbraId:       m.id,
            conversationId: msg.conversationId,
            subject:        m.subject,
            snippet:        m.snippet,
            fromEmail:      m.from.email,
            fromName:       m.from.name ?? null,
            toRecipients:   mapAddresses(m.to),
            ccRecipients:   mapAddresses(m.cc),
            bccRecipients:  mapAddresses(m.bcc),
            isRead:         m.isRead,
            isStarred:      m.isFlagged,
            isDraft:        m.isDraft,
            hasAttachments: m.hasAttachments,
            receivedAt:     m.receivedAt,
          }];
        });

        if (rows.length > 0) {
          await this.prisma.message.createMany({ data: rows, skipDuplicates: true });
        }
      }
    } catch (err: any) {
      // Back-fill is best-effort — a provider outage must not break the thread view
      this.logger.warn(`[getConversation] conversation back-fill failed: ${err?.message}`);
    }

    const messages = await this.prisma.message.findMany({
      where: { userId, conversationId: msg.conversationId },
      orderBy: { receivedAt: 'asc' },
      select: {
        id: true,
        zimbraId: true,
        conversationId: true,
        subject: true,
        snippet: true,
        fromEmail: true,
        fromName: true,
        toRecipients: true,
        ccRecipients: true,
        isRead: true,
        isStarred: true,
        isDraft: true,
        hasAttachments: true,
        attachments: true,
        receivedAt: true,
      },
    });

    return { conversationId: msg.conversationId, messages };
  }

  async searchMessages(userId: string, query: string, limit = 50, offset = 0) {
    const user = await this.getUser(userId);

    const page = await this.resolver.forUser(user).searchMessages(
      buildMailSession(user),
      query,
      limit,
      offset,
    );

    return this.persistSearchResults(userId, page, limit, offset);
  }

  async searchStructured(userId: string, filter: MailSearchFilter, limit = 50, offset = 0) {
    if (isEmptyFilter(filter)) throw new BadRequestException('At least one filter is required.');

    for (const d of [filter.dateFrom, filter.dateTo]) {
      if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d.trim())) {
        throw new BadRequestException('Invalid date format; expected YYYY-MM-DD.');
      }
    }

    const user = await this.getUser(userId);

    // The web always sends DB folder ids (same contract as getMessages), but
    // providers only understand their own provider id (zimbraId) — resolve
    // by DB id here and forward the translated id, mirroring getMessages above.
    let providerFilter = filter;
    if (filter.folderId) {
      const folder = await this.prisma.folder.findFirst({
        where: { userId, id: filter.folderId },
      });
      if (!folder) throw new NotFoundException('Folder not found');
      providerFilter = { ...filter, folderId: folder.zimbraId };
    }

    const page = await this.resolver.forUser(user).searchStructured(
      buildMailSession(user),
      providerFilter,
      limit,
      offset,
    );

    return this.persistSearchResults(userId, page, limit, offset);
  }

  // Shared by searchMessages and searchStructured: maps provider results →
  // the shape the client already knows, upserting to DB where the message's
  // folder is already synced, else returning a lightweight ephemeral row.
  // Never touches conversationId on the update path — search must not
  // disturb threading established elsewhere (e.g. getConversation back-fill).
  private async persistSearchResults(
    userId: string,
    page: ProviderMessagePage,
    limit: number,
    offset: number,
  ) {
    const { messages, total, more } = page;

    // Nothing to persist: skip the folder read entirely so an empty result set
    // costs zero DB round-trips.
    if (messages.length === 0) {
      return { messages: [] as any[], total, offset, limit, hasMore: more };
    }

    // One folder read for the whole page. This used to be a `findFirst` per
    // message which, together with the per-message upsert below, cost ~2
    // sequential round-trips per result — measured at 5.7s of a 7.7s search
    // for a 50-result page.
    const folders = await this.prisma.folder.findMany({
      where: { userId },
      select: { id: true, zimbraId: true },
    });
    const folderIdByZimbraId = new Map(folders.map((f) => [f.zimbraId, f.id]));

    /** Shape returned for a result we cannot persist (folder not synced yet, or
     *  its write failed): `id` is the provider id so getMessage's fallback path
     *  can still open it. Mirrors the persisted row's metadata-only shape. */
    const ephemeral = (m: ProviderMessage) => ({
      id:             m.id,
      zimbraId:       m.id,
      subject:        m.subject,
      snippet:        m.snippet,
      fromEmail:      m.from.email,
      fromName:       m.from.name ?? null,
      toRecipients:   mapAddresses(m.to),
      ccRecipients:   mapAddresses(m.cc),
      bccRecipients:  mapAddresses(m.bcc),
      isRead:         m.isRead,
      isStarred:      m.isFlagged,
      hasAttachments: m.hasAttachments,
      receivedAt:     m.receivedAt,
      // Tag sync is not implemented — the DB rows carry [] too, and the
      // provider's parsed `tags` are deliberately not surfaced here so
      // the ephemeral and persisted shapes stay identical.
      tags:           [],
    });

    const upsertArgs = (m: ProviderMessage, folderId: string) => ({
      where:  { userId_zimbraId: { userId, zimbraId: m.id } },
      update: {
        isRead: m.isRead,
        isStarred: m.isFlagged,
        syncedAt: new Date(),
        ...recipientRefresh(m),
      },
      create: {
        userId,
        folderId,
        zimbraId:       m.id,
        conversationId: m.conversationId,
        subject:        m.subject,
        snippet:        m.snippet,
        fromEmail:      m.from.email,
        fromName:       m.from.name ?? null,
        toRecipients:   mapAddresses(m.to),
        ccRecipients:   mapAddresses(m.cc),
        bccRecipients:  mapAddresses(m.bcc),
        isRead:         m.isRead,
        isStarred:      m.isFlagged,
        hasAttachments: m.hasAttachments,
        receivedAt:     m.receivedAt,
      },
      select: MESSAGE_LIST_SELECT,
    });

    const persistable = messages.flatMap((m) => {
      const folderId = folderIdByZimbraId.get(m.folderId);
      return folderId ? [{ m, folderId }] : [];
    });

    // Batch every write into ONE transaction round-trip instead of one per row.
    const rowByProviderId = new Map<string, any>();
    if (persistable.length > 0) {
      try {
        const rows = await this.prisma.$transaction(
          persistable.map(({ m, folderId }) => this.prisma.message.upsert(upsertArgs(m, folderId))),
        );
        for (const row of rows) rowByProviderId.set(row.zimbraId, row);
      } catch (err: any) {
        // A single bad row aborts the whole transaction, so fall back to
        // per-row writes: one failure must not cost the user every result.
        this.logger.error(`Search batch upsert failed (${err?.message}) — falling back to per-row writes`);
        for (const { m, folderId } of persistable) {
          try {
            const row = await this.prisma.message.upsert(upsertArgs(m, folderId));
            rowByProviderId.set(row.zimbraId, row);
          } catch (rowErr: any) {
            this.logger.error(`Search upsert failed for zimbraId=${m.id}: ${rowErr?.message}`);
          }
        }
      }
    }

    // Provider order is the result order; anything unpersisted degrades to an
    // ephemeral row rather than vanishing from the page.
    const saved = messages.map((m) => rowByProviderId.get(m.id) ?? ephemeral(m));

    return { messages: saved, total, offset, limit, hasMore: more };
  }

  async downloadAttachment(userId: string, messageId: string, partId: string) {
    const user = await this.getUser(userId);

    const msg = await this.prisma.message.findFirst({ where: { userId, id: messageId } });
    if (!msg) throw new NotFoundException('Message not found');

    return this.resolver
      .forUser(user)
      .downloadAttachment(buildMailSession(user), msg.zimbraId, partId);
  }

  /**
   * Bytes for one inline image. Cache first, provider on a miss.
   *
   * The part must be declared in the message's own `inlineImages`. Without that
   * check this route would be a general attachment reader with a cache bolted
   * on, reachable for any part of any message the caller owns.
   */
  async getInlineImage(
    userId: string,
    messageId: string,
    partId: string,
  ): Promise<{ data: Buffer; contentType: string; cached: boolean }> {
    const msg = await this.prisma.message.findFirst({ where: { userId, id: messageId } });
    if (!msg) throw new NotFoundException('Message not found');

    const declared = ((msg.inlineImages as any[]) ?? [])
      .find((i) => i?.partId === partId);
    if (!declared) throw new NotFoundException('Inline image not found');

    const hit = await this.inlineCache.read(userId, messageId, partId);
    if (hit) {
      return { data: hit, contentType: declared.mimeType ?? 'application/octet-stream', cached: true };
    }

    const user = await this.getUser(userId);
    const { data, contentType } = await this.resolver
      .forUser(user)
      .downloadAttachmentBuffer(buildMailSession(user), msg.zimbraId, partId);

    await this.inlineCache.write(userId, messageId, partId, data);
    return { data, contentType: contentType ?? declared.mimeType, cached: false };
  }

  async sendMessage(
    userId: string,
    payload: {
      to: string[];
      cc?: string[];
      bcc?: string[];
      subject: string;
      body: string;
      bodyFormat?: 'markdown';
      replyToId?: string;
      replyType?: 'r' | 'w';
      forwardedAttachments?: Array<{ mid: string; part: string }>;
    },
    files: Express.Multer.File[] = [],
  ) {
    const user = await this.getUser(userId);
    const provider = this.resolver.forUser(user);
    const session = buildMailSession(user);

    // Agent-approved sends deliver the body as markdown: convert it to HTML
    // and append the user's signature, matching what draft_email produces.
    if (payload.bodyFormat === 'markdown') {
      payload = { ...payload, body: await this.renderMarkdownBody(userId, payload.body) };
    }

    // Resolve replyToId: the frontend sends our internal Prisma CUID, but
    // Zimbra's origid expects the numeric zimbraId.
    let zimbraReplyToId: string | undefined;
    if (payload.replyToId) {
      const orig = await this.prisma.message.findFirst({
        where: { userId, id: payload.replyToId },
        select: { zimbraId: true },
      });
      zimbraReplyToId = orig?.zimbraId ?? payload.replyToId;
    }

    // ── Clean the outgoing HTML body + extract inline images ─────────────────
    //
    // Every data:image/… URI in the body (signature logos, small pasted images)
    // is converted to a proper CID inline attachment so recipients see the image
    // regardless of their email client.  Large data URIs in quoted content (>50 KB)
    // that are NOT images, or images we fail to upload, are stripped to src="".
    //
    // Step 1 — collect all data:image/… URIs and schedule them for upload.
    interface InlineImageInfo {
      dataUri: string;          // full "data:image/png;base64,…" string
      contentType: string;      // e.g. "image/png"
      base64Data: string;       // raw base64 payload
      cid: string;              // generated Content-ID (without angle brackets)
    }

    this.logger.log(`[sendMessage] payload.body length: ${payload.body.length}`);

    const pendingImages: InlineImageInfo[] = [];
    // Strip data-zimbra-src while collecting — that attribute was only needed
    // for the round-trip save path and is meaningless in outgoing mail.
    // Handle both double-quoted and single-quoted src attributes.
    let cleanBody = payload.body
      .replace(/\s*data-zimbra-src=["'][^"']*["']/gi, '')
      .replace(
        /src=(["'])(data:(image\/[^;]+);base64,([^"']{1,5000000}))\1/gi,
        (_m: string, _q: string, dataUri: string, contentType: string, base64Data: string) => {
          const cid = `img${pendingImages.length}-${Date.now()}@govmail`;
          pendingImages.push({ dataUri, contentType, base64Data, cid });
          return `src="cid:${cid}"`;
        },
      );

    this.logger.log(`[sendMessage] after step1: cleanBody.length=${cleanBody.length} pendingImages=${pendingImages.length} hasDataUri=${cleanBody.includes('data:')}`);

    // Step 2 — strip ALL remaining data URIs unconditionally.
    // Any data: URI that survived step 1 (wrong type, too large, or from
    // quoted original content) must not be forwarded to Zimbra as-is.
    cleanBody = cleanBody.replace(/src=["']data:[^"']*["']/gi, 'src=""');

    this.logger.log(`[sendMessage] after step2: cleanBody.length=${cleanBody.length} hasDataUri=${cleanBody.includes('data:')}`);

    // Step 2.5 — trim thread quote if body still exceeds Zimbra's SOAP request limit.
    // Fallback for edge cases where the frontend didn't strip nested blockquotes
    // (e.g., very large direct-parent email, plain-text fallback, etc.).
    // Zimbra's zimbraSoapRequestMaxSize is 15,360,000 bytes; 12MB gives safe headroom.
    const BODY_SAFE_LIMIT = 12 * 1024 * 1024;
    if (cleanBody.length > BODY_SAFE_LIMIT) {
      const sepMatch = /<br\/?>\s*<br\/?>\s*<div[^>]*color:\s*#999/i.exec(cleanBody);
      if (sepMatch) {
        cleanBody =
          cleanBody.slice(0, sepMatch.index) +
          '<p style="color:#999;font-size:11px;font-style:italic;">[Previous messages omitted — thread too large to quote]</p>';
      } else {
        const bqIdx = cleanBody.lastIndexOf('<blockquote');
        if (bqIdx !== -1) {
          cleanBody =
            cleanBody.slice(0, bqIdx) +
            '<p style="color:#999;font-size:11px;font-style:italic;">[Previous messages omitted — thread too large to quote]</p>';
        }
      }
      this.logger.warn(`[sendMessage] Thread quote trimmed (backend fallback): body was ${cleanBody.length} chars after trim`);
    }

    // Step 3 — upload each collected image to Zimbra and get an attachment ID.
    const inlineImageAids: Array<{ aid: string; cid: string; ct: string }> = [];
    const failedCids: string[] = [];
    await Promise.all(
      pendingImages.map(async (img) => {
        try {
          const buf = Buffer.from(img.base64Data, 'base64');
          const ext = img.contentType.split('/')[1]?.replace(/\+.*$/, '') || 'bin';
          const aid = await provider.uploadAttachment(
            session,
            `inline.${ext}`,
            img.contentType,
            buf,
          );
          inlineImageAids.push({ aid, cid: img.cid, ct: img.contentType });
        } catch (err: any) {
          this.logger.warn(`Failed to upload inline image (${img.contentType}): ${err?.message}`);
          failedCids.push(img.cid);
        }
      }),
    );
    // Replace failed CID references with empty src (safe sequential mutation)
    for (const cid of failedCids) {
      cleanBody = cleanBody.replace(`src="cid:${cid}"`, 'src=""');
    }

    // Upload each attachment to Zimbra and collect their attachment IDs.
    let attachmentAids: string[] = [];
    if (files.length > 0) {
      attachmentAids = await Promise.all(
        files.map((f) =>
          provider.uploadAttachment(session, f.originalname, f.mimetype, f.buffer),
        ),
      );
    }

    // Resolve forwarded attachment references: translate our internal Prisma
    // message IDs to Zimbra numeric IDs so the SOAP request can use <mp mid=…>.
    let resolvedForwardedAttachments: Array<{ mid: string; part: string }> = [];
    if (payload.forwardedAttachments?.length) {
      const midSet = new Set(payload.forwardedAttachments.map((a) => a.mid));
      const idToZimbraId = new Map<string, string>();
      await Promise.all(
        Array.from(midSet).map(async (prismaId) => {
          const msg = await this.prisma.message.findFirst({
            where: { userId, id: prismaId },
            select: { zimbraId: true },
          });
          if (msg?.zimbraId) idToZimbraId.set(prismaId, msg.zimbraId);
        }),
      );
      resolvedForwardedAttachments = payload.forwardedAttachments
        .map((a) => ({ mid: idToZimbraId.get(a.mid) ?? a.mid, part: a.part }));
    }

    let sendResult: { id: string | null; conversationId: string | null };
    try {
      sendResult = await provider.sendMessage(
        session,
        { ...payload, body: cleanBody, replyToId: zimbraReplyToId },
        attachmentAids,
        inlineImageAids,
        resolvedForwardedAttachments,
      );
    } catch (err: any) {
      if (err instanceof UnauthorizedException) {
        await this.prisma.user.update({
          where: { id: userId },
          data: { authToken: null, tokenExpiry: null },
        });
      }
      throw err;
    }
    const { id: sentZimbraId, conversationId: sentCid } = sendResult;

    // Persist the sent message to the local DB so it appears in thread view.
    // Best-effort: a failure here must NOT prevent the 200 response reaching
    // the client (the message was already delivered by Zimbra).
    if (sentZimbraId) {
      try {
        // Find the Sent folder — Zimbra's standard path is /Sent.
        const sentFolder = await this.prisma.folder.findFirst({
          where: { userId, path: '/Sent' },
        });

        if (sentFolder) {
          // Determine the conversationId: prefer Zimbra's cid; fall back to the
          // original message's conversationId when replying.
          let resolvedConversationId: string | null = sentCid;
          if (!resolvedConversationId && zimbraReplyToId) {
            const origMsg = await this.prisma.message.findFirst({
              where: { userId, zimbraId: zimbraReplyToId },
              select: { conversationId: true },
            });
            resolvedConversationId = origMsg?.conversationId ?? null;
          }

          await this.prisma.message.upsert({
            where: { userId_zimbraId: { userId, zimbraId: sentZimbraId } },
            update: { syncedAt: new Date() },
            create: {
              userId,
              folderId:       sentFolder.id,
              zimbraId:       sentZimbraId,
              conversationId: resolvedConversationId,
              subject:        payload.subject ?? null,
              snippet:        null,
              fromEmail:      user.email,
              fromName:       user.displayName ?? null,
              toRecipients:   payload.to.map((a) => ({ email: a, name: null })),
              ccRecipients:   (payload.cc ?? []).map((a) => ({ email: a, name: null })),
              bccRecipients:  (payload.bcc ?? []).map((a) => ({ email: a, name: null })),
              isRead:         true,
              isDraft:        false,
              hasAttachments: files.length > 0,
              receivedAt:     new Date(),
            },
          });
        }
      } catch (err: any) {
        this.logger.warn(`Failed to persist sent message zimbraId=${sentZimbraId}: ${err?.message}`);
      }
    }

    return { success: true };
  }

  async deleteMessage(userId: string, messageId: string) {
    const user = await this.getUser(userId);
    const msg = await this.prisma.message.findFirst({ where: { userId, id: messageId } });
    if (!msg) throw new NotFoundException('Message not found');

    await this.resolver.forUser(user).deleteMessage(buildMailSession(user), msg.zimbraId);
    await this.prisma.message.delete({ where: { id: messageId } });
    return { success: true };
  }

  async markRead(userId: string, messageId: string, read: boolean) {
    const user = await this.getUser(userId);
    const msg = await this.prisma.message.findFirst({ where: { userId, id: messageId } });
    if (!msg) throw new NotFoundException('Message not found');

    await this.resolver.forUser(user).markRead(buildMailSession(user), msg.zimbraId, read);
    return this.prisma.message.update({
      where: { id: messageId },
      data: { isRead: read },
    });
  }

  /**
   * Replace every `cid:` reference in the HTML with a base64 data URI fetched
   * from Zimbra.  After CID embedding, also replaces Zimbra REST home URLs
   * (used by signature images stored in Zimbra briefcase) with data URIs.
   * Any remaining unresolvable `cid:` references are stripped so the browser
   * does not display broken-image icons.
   */
  private async embedInlineImages(
    html: string,
    inlineImages: Array<{ cid: string; partId: string; mimeType: string }>,
    // The user row, not just the session: pass 2 needs the provider (and, for
    // Zimbra, the resolver's Zimbra-only path fetch), which is keyed off
    // User.provider.
    user: MailSessionUser,
    messageId: string,
  ): Promise<string> {
    let processed = html;
    const provider = this.resolver.forUser(user);
    const session = buildMailSession(user);

    // ── Pass 1: CID inline attachments ────────────────────────────────────────
    if (inlineImages.length > 0) {
      await Promise.all(
        inlineImages.map(async (img) => {
          try {
            const { data, contentType } = await provider.downloadAttachmentBuffer(
              session,
              messageId,
              img.partId,
            );
            const dataUri = `data:${contentType};base64,${data.toString('base64')}`;
            // CIDs are stored with surrounding angle brackets (e.g. <img0@govmail>)
            // but HTML src="cid:..." references never include them — strip before matching.
            const rawCid  = img.cid.replace(/^<|>$/g, '');
            const esc     = rawCid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // HTML may encode '@' as '&#64;' or '&#x40;' — match all variants
            const escCid  = esc.replace(/@/g, '(?:@|&#(?:64|x40);)');
            const escBase = esc.split('@')[0];
            processed = processed
              .replace(new RegExp(`src=["']cid:${escCid}["']`,  'gi'), `src="${dataUri}"`)
              .replace(new RegExp(`src=["']cid:${escBase}["']`, 'gi'), `src="${dataUri}"`);
          } catch {
            // individual image failure is handled below (stripped in pass 3)
          }
        }),
      );
    }

    // ── Pass 2: Zimbra-hosted image URLs (e.g. signature logos in Briefcase) ──
    processed = await this.embedZimbraHostedImages(processed, user);

    // ── Pass 3: Strip any remaining cid: references that could not be resolved ─
    // Browsers cannot load cid: URLs — they render as broken-image icons.
    // Replacing with src="" causes the browser to skip the image silently.
    processed = processed.replace(/src=["']cid:[^"']*["']/gi, 'src=""');

    return processed;
  }

  /**
   * Find every src attribute pointing to this Zimbra server in the HTML,
   * download the resource server-side (with the user's auth token), and
   * replace the src with a base64 data URI.
   *
   * Handles all Zimbra-hosted image patterns:
   *   • /service/home/~/?id=X&part=Y  — inline attachments (uses downloadAttachmentBuffer)
   *   • /service/proxy/?target=…      — Zimbra image-proxy for external images
   *   • /home/user@domain/path        — Briefcase path-based URLs
   *   • Any other path on this host   — generic Zimbra REST resources
   *
   * Only image/* content types are embedded; other types are left unchanged.
   */
  private async embedZimbraHostedImages(
    html: string,
    // The user row is the single source of provider truth here: the provider
    // is resolved from it below rather than passed in, so a caller cannot hand
    // over a provider that disagrees with `user.provider` (which the
    // Zimbra-only path branch checks).
    user: MailSessionUser,
  ): Promise<string> {
    const provider = this.resolver.forUser(user);
    const session = buildMailSession(user);
    if (!session.authToken) return html;

    const escapedHost = session.host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match ANY src attribute pointing to this Zimbra server (http or https)
    const urlRe = new RegExp(
      `src=["'](https?://${escapedHost}/[^"']*)["']`,
      'gi',
    );

    const matches: Array<{ full: string; url: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = urlRe.exec(html)) !== null) {
      matches.push({ full: m[0], url: m[1] });
    }

    if (matches.length === 0) return html;

    let processed = html;
    await Promise.all(
      matches.map(async ({ full, url }) => {
        try {
          const parsed = new URL(url);
          const id   = parsed.searchParams.get('id');
          const part = parsed.searchParams.get('part');

          let data: Buffer;
          let contentType: string;

          if (id && part) {
            // Standard inline attachment served via the Zimbra REST home endpoint
            ({ data, contentType } = await provider.downloadAttachmentBuffer(session, id, part));
          } else {
            // Path-based URL (Briefcase image, image-proxy, or other Zimbra
            // resource). downloadZimbraPath is a Zimbra-only extra, off the
            // MailProvider interface, so it is reached through the resolver
            // behind an explicit provider check; any other backend leaves the
            // original URL in place (same graceful outcome as a failed fetch).
            if (user.provider !== 'zimbra') return;
            // downloadZimbraPath appends ?auth=qp&zauthtoken=... for query-param auth
            const relativePath = parsed.pathname + (parsed.search || '');
            ({ data, contentType } = await this.resolver.zimbra().downloadZimbraPath(
              session.host,
              session.authToken!,
              relativePath,
            ));
          }

          // Only embed image types; leave documents/videos/etc. with their original URL
          if (!contentType.startsWith('image/')) return;

          const dataUri = `data:${contentType};base64,${data.toString('base64')}`;
          // Replace the exact matched attribute (literal string replace, no regex)
          processed = processed.split(full).join(`src="${dataUri}"`);
        } catch {
          // leave the original URL in place; browser will try (and likely fail) to load it
        }
      }),
    );

    return processed;
  }

  // The MIME-part walking itself lives in zimbra.mappers.ts. These two only
  // reshape the neutral ProviderAttachmentMeta into the two JSON column shapes
  // the DB and the REST responses have always used — renaming them would be a
  // breaking API change for the web client.

  /** Real attachments, as stored on `Message.attachments`. */
  private toStoredAttachments(
    attachments: ProviderAttachmentMeta[] | undefined,
  ): Array<{ id: string; filename: string; mimeType: string; size: number }> {
    return (attachments ?? [])
      .filter((a) => !a.isInline)
      .map((a) => ({ id: a.part, filename: a.filename, mimeType: a.contentType, size: a.size }));
  }

  /** CID-referenced inline images (signature logos, pasted images), as stored
   *  on `Message.inlineImages`. Excluded from the attachment list so they never
   *  inflate attachment counts or the "has attachment" filter. */
  private toStoredInlineImages(
    attachments: ProviderAttachmentMeta[] | undefined,
  ): Array<{ cid: string; partId: string; mimeType: string }> {
    return (attachments ?? [])
      .filter((a) => a.isInline)
      .map((a) => ({ cid: a.contentId ?? '', partId: a.part, mimeType: a.contentType }));
  }

  async moveMessage(userId: string, messageId: string, targetFolderOurId: string) {
    const user = await this.getUser(userId);

    const message = await this.prisma.message.findFirst({ where: { userId, id: messageId } });
    if (!message) throw new NotFoundException('Message not found');

    const targetFolder = await this.prisma.folder.findFirst({ where: { userId, id: targetFolderOurId } });
    if (!targetFolder) throw new NotFoundException('Target folder not found');

    await this.resolver
      .forUser(user)
      .moveMessage(buildMailSession(user), message.zimbraId, targetFolder.zimbraId);

    await this.prisma.message.update({
      where: { id: messageId },
      data: { folderId: targetFolderOurId },
    });

    return { success: true };
  }

  /**
   * "Not spam": rescue a message from Junk AND stop the rules that put it
   * there from putting it back.
   *
   * The move alone is not enough. `enforceSenderRules` re-files mail from a
   * BLOCKed sender on every Inbox sync (and the sweep cron does the same), so a
   * rescued message would reappear in Junk minutes later and the button would
   * look broken. Clearing the block is therefore part of the operation, not a
   * separate courtesy.
   */
  async markNotSpam(userId: string, messageId: string) {
    const user = await this.getUser(userId);

    const message = await this.prisma.message.findFirst({ where: { userId, id: messageId } });
    if (!message) throw new NotFoundException('Message not found');

    const currentFolder = await this.prisma.folder.findFirst({ where: { userId, id: message.folderId } });
    if (!isSpamFolderPath(currentFolder?.path)) {
      throw new BadRequestException('This message is not in the spam folder.');
    }

    const inbox = await this.prisma.folder.findFirst({ where: { userId, path: '/Inbox' } });
    if (!inbox) throw new NotFoundException('No Inbox folder is synced for this account');

    await this.resolver
      .forUser(user)
      .moveMessage(buildMailSession(user), message.zimbraId, inbox.zimbraId);
    await this.prisma.message.update({ where: { id: messageId }, data: { folderId: inbox.id } });

    const unblocked = await this.unblockSender(userId, message.fromEmail);
    return { success: true, unblocked };
  }

  /**
   * Make `fromEmail` deliverable again, with the lightest touch that works.
   *
   * An exact-address BLOCK is simply deleted. A DOMAIN-wide BLOCK is left
   * alone — dismantling a whole domain policy because one message was rescued
   * is far more than the user asked for — and the sender is carved out of it
   * with a narrower ALLOW instead, which is exactly the pairing
   * `matchSenderRule` documents (ALLOW wins over BLOCK). Both can apply at
   * once: deleting the exact rule still leaves the domain rule matching.
   *
   * Returns whether anything changed, so the caller can tell the user.
   */
  private async unblockSender(userId: string, fromEmail: string): Promise<boolean> {
    const email = (fromEmail ?? '').trim().toLowerCase();
    if (!email) return false;

    const rules = await this.prisma.senderRule.findMany({ where: { userId } });
    if (matchSenderRule(email, rules) !== 'BLOCK') return false;

    const exact = rules.find(
      (rule) => rule.type === 'BLOCK' && rule.address.trim().toLowerCase() === email,
    );
    if (exact) await this.prisma.senderRule.delete({ where: { id: exact.id } });

    const remaining = exact ? rules.filter((rule) => rule.id !== exact.id) : rules;
    if (matchSenderRule(email, remaining) === 'BLOCK') {
      await this.prisma.senderRule.create({ data: { userId, type: 'ALLOW', address: email } });
    }

    return true;
  }

  async deleteFolder(userId: string, folderId: string) {
    const user = await this.getUser(userId);

    const folder = await this.prisma.folder.findFirst({
      where: { userId, id: folderId },
    });
    if (!folder) throw new NotFoundException('Folder not found');

    await this.resolver.forUser(user).deleteFolder(buildMailSession(user), folder.zimbraId);

    // Remove any locally-cached messages in this folder (they are re-fetched on demand)
    await this.prisma.message.deleteMany({ where: { folderId } });

    await this.prisma.folder.delete({ where: { id: folderId } });

    return { success: true };
  }

  async emptyFolder(userId: string, folderId: string) {
    const user = await this.getUser(userId);

    const folder = await this.prisma.folder.findFirst({
      where: { userId, id: folderId },
    });
    if (!folder) throw new NotFoundException('Folder not found');

    await this.resolver.forUser(user).emptyFolder(buildMailSession(user), folder.zimbraId);

    // Clear locally-cached messages so the list refreshes on next load
    await this.prisma.message.deleteMany({ where: { folderId } });
    await this.prisma.folder.update({
      where: { id: folderId },
      data: { unreadCount: 0, totalCount: 0 },
    });

    return { success: true };
  }

  async renameFolder(userId: string, folderId: string, name: string) {
    const user = await this.getUser(userId);

    const folder = await this.prisma.folder.findFirst({
      where: { userId, id: folderId },
    });
    if (!folder) throw new NotFoundException('Folder not found');

    await this.resolver.forUser(user).renameFolder(buildMailSession(user), folder.zimbraId, name);

    return this.prisma.folder.update({
      where: { id: folderId },
      data: { name, path: `/${name}` },
    });
  }

  async createFolder(userId: string, name: string) {
    const user = await this.getUser(userId);

    const created = await this.resolver.forUser(user).createFolder(buildMailSession(user), name);

    const folder = await this.prisma.folder.upsert({
      where: { userId_zimbraId: { userId, zimbraId: created.id } },
      update: { name: created.name, path: created.path, syncedAt: new Date() },
      create: {
        userId,
        zimbraId: created.id,
        name: created.name,
        path: created.path,
        unreadCount: 0,
        totalCount: 0,
        syncedAt: new Date(),
      },
    });

    return folder;
  }

  // ─── Drafts ─────────────────────────────────────────────────────────────────

  /**
   * Resolve the user's default signature as HTML, mirroring the compose
   * modal's client-side resolution: the primary identity's configured
   * default signature, then the prefs-level default, then the first
   * available signature. Text-only signatures are converted to simple
   * paragraphs. Returns '' when the user has no signatures — and on any
   * Zimbra error, so callers composing a body never fail on the signature.
   */
  async getDefaultSignatureHtml(userId: string): Promise<string> {
    try {
      const user = await this.getUser(userId);
      const provider = this.resolver.forUser(user);
      const session = buildMailSession(user);
      const [prefs, identities, signatures] = await Promise.all([
        provider.getPrefs(session),
        provider.getIdentities(session),
        provider.getSignatures(session),
      ]);
      if (!signatures.length) return '';

      const resolve = (sig?: { contentHtml: string; contentText: string }): string => {
        if (sig?.contentHtml) return sig.contentHtml;
        if (sig?.contentText) {
          return sig.contentText
            .split('\n')
            .map((line) => `<p>${line || '<br>'}</p>`)
            .join('');
        }
        return '';
      };

      const attrs = identities[0]?.attrs ?? {};
      const id = attrs.zimbraPrefDefaultSignatureId || prefs.zimbraPrefDefaultSignatureId || '';
      let html = '';
      if (id) {
        html = resolve(signatures.find((s) => s.id === id));
      }
      if (!html) html = resolve(signatures[0]);
      if (!html) return '';
      // Briefcase-image inlining is a Zimbra-only extra (downloadZimbraPath is
      // off the interface); other providers ship the signature HTML as-is.
      if (user.provider !== 'zimbra') return html;
      return inlineSignatureImages(this.resolver.zimbra(), user, html);
    } catch (err: any) {
      this.logger.warn(`getDefaultSignatureHtml failed: ${err?.message}`);
      return '';
    }
  }

  /**
   * Render an agent-authored markdown body as final email HTML: the escaped
   * markdown conversion followed by the user's default signature in the same
   * `<div data-sig="1">` wrapper the compose modal uses (so opening the
   * result in compose never double-injects a signature).
   */
  private async renderMarkdownBody(userId: string, markdown: string): Promise<string> {
    const sigHtml = await this.getDefaultSignatureHtml(userId);
    return mdToHtml(markdown) + (sigHtml ? `<p><br></p><div data-sig="1">${sigHtml}</div>` : '');
  }

  /**
   * Save or update a Zimbra draft.
   * If `payload.draftId` is supplied, the existing draft is updated in-place;
   * otherwise a new draft is created in the Drafts folder.
   * `bodyFormat: 'markdown'` marks an agent-authored body: it is converted to
   * HTML and the user's default signature is appended before saving.
   * Returns the Zimbra message ID of the (new or updated) draft.
   */
  async saveDraft(
    userId: string,
    payload: {
      to?: string[];
      cc?: string[];
      bcc?: string[];
      subject?: string;
      body?: string;
      bodyFormat?: 'markdown';
      draftId?: string;
    },
  ): Promise<{ zimbraId: string }> {
    const user = await this.getUser(userId);
    if (payload.bodyFormat === 'markdown') {
      payload = { ...payload, body: await this.renderMarkdownBody(userId, payload.body ?? '') };
    }
    const zimbraId = await this.resolver.forUser(user).saveDraft(buildMailSession(user), {
      id: payload.draftId,
      to: payload.to,
      cc: payload.cc,
      bcc: payload.bcc,
      subject: payload.subject,
      body: payload.body,
    });
    return { zimbraId };
  }

  /**
   * Permanently discard a draft by moving it to Trash.
   * `zimbraId` is the Zimbra message ID returned by saveDraft.
   */
  async discardDraft(
    userId: string,
    zimbraId: string,
  ): Promise<{ success: boolean }> {
    const user = await this.getUser(userId);
    await this.resolver.forUser(user).deleteMessage(buildMailSession(user), zimbraId);
    // Remove the draft from the local DB so it no longer appears in conversation fetches.
    await this.prisma.message.deleteMany({ where: { userId, zimbraId } });
    return { success: true };
  }

  // ─── Snooze ─────────────────────────────────────────────────────────────────

  async snoozeMessage(userId: string, messageId: string, snoozedUntil: string, originalFolderId: string) {
    await this.getUser(userId);
    const snoozeId = `snooze-${userId}-${messageId}`;
    return this.prisma.snoozedMessage.upsert({
      where: { id: snoozeId },
      create: { id: snoozeId, userId, messageId, snoozedUntil: new Date(snoozedUntil), originalFolderId },
      update: { snoozedUntil: new Date(snoozedUntil), originalFolderId },
    });
  }

  async unsnoozeMessage(userId: string, messageId: string) {
    await this.prisma.snoozedMessage.deleteMany({ where: { userId, messageId } });
    return { success: true };
  }

  async getSnoozed(userId: string) {
    await this.getUser(userId);
    return this.prisma.snoozedMessage.findMany({ where: { userId }, orderBy: { snoozedUntil: 'asc' } });
  }

  /** Called by MailScheduler — move messages whose snooze has expired back to their folder */
  async processExpiredSnoozes() {
    const expired = await this.prisma.snoozedMessage.findMany({
      where: { snoozedUntil: { lte: new Date() } },
      include: { user: true },
    });
    for (const snooze of expired) {
      try {
        const user = snooze.user as any;
        if (!user.authToken) { await this.prisma.snoozedMessage.delete({ where: { id: snooze.id } }); continue; }
        const msg = await this.prisma.message.findFirst({ where: { userId: snooze.userId, id: snooze.messageId } });
        if (msg) {
          const targetFolder = await this.prisma.folder.findFirst({ where: { userId: snooze.userId, id: snooze.originalFolderId } });
          if (targetFolder) {
            await this.resolver
              .forUser(user)
              .moveMessage(buildMailSession(user), msg.zimbraId, targetFolder.zimbraId);
            await this.prisma.message.update({ where: { id: msg.id }, data: { folderId: snooze.originalFolderId } });
          }
        }
        await this.prisma.snoozedMessage.delete({ where: { id: snooze.id } });
        await this.notifications.createNotification(
          snooze.userId,
          'MAIL_SNOOZE_EXPIRED',
          `Snoozed message returned: ${msg?.subject ?? '(no subject)'}`,
          'Your snoozed message is back in your inbox.',
          '/mail',
        ).catch(() => {});
      } catch (err: any) {
        this.logger.warn(`Failed to unsnooze message ${snooze.messageId}: ${err?.message}`);
      }
    }
  }

  // ─── Scheduled Send ──────────────────────────────────────────────────────────

  async scheduleMessage(userId: string, payload: {
    sendAt: string; to: string[]; cc?: string[]; bcc?: string[]; subject?: string; body?: string;
  }) {
    await this.getUser(userId);
    return this.prisma.scheduledMessage.create({
      data: {
        userId,
        sendAt: new Date(payload.sendAt),
        to: payload.to,
        cc: payload.cc ?? [],
        bcc: payload.bcc ?? [],
        subject: payload.subject ?? null,
        body: payload.body ?? null,
      },
    });
  }

  async cancelScheduledMessage(userId: string, id: string) {
    const msg = await this.prisma.scheduledMessage.findFirst({ where: { userId, id } });
    if (!msg) throw new NotFoundException('Scheduled message not found');
    // Only PENDING rows can be cancelled: once processDueScheduled has claimed
    // one as SENDING the send is already in flight, and reporting it cancelled
    // would contradict the mail the recipient receives.
    const cancelled = await this.prisma.scheduledMessage.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });
    if (cancelled.count === 0) {
      throw new ConflictException('Message is already being sent and can no longer be cancelled');
    }
    return this.prisma.scheduledMessage.findUnique({ where: { id } });
  }

  async getScheduledMessages(userId: string) {
    await this.getUser(userId);
    return this.prisma.scheduledMessage.findMany({
      where: { userId, status: 'PENDING' },
      orderBy: { sendAt: 'asc' },
    });
  }

  /** Called by MailScheduler — send all due scheduled messages */
  async processDueScheduled() {
    // Sweep rows stranded in SENDING by a crash mid-send; mark FAILED rather
    // than PENDING so an uncertain send is never retried as a duplicate.
    const stuckBefore = new Date(Date.now() - 15 * 60 * 1000);
    const swept = await this.prisma.scheduledMessage.updateMany({
      where: { status: 'SENDING', updatedAt: { lt: stuckBefore } },
      data: { status: 'FAILED', errorMsg: 'Send did not complete (stuck in SENDING)' },
    });
    if (swept.count > 0) {
      this.logger.warn(`Marked ${swept.count} scheduled message(s) stuck in SENDING as FAILED`);
    }

    const due = await this.prisma.scheduledMessage.findMany({
      where: { status: 'PENDING', sendAt: { lte: new Date() } },
      include: { user: true },
    });
    for (const msg of due) {
      const user = msg.user as any;
      if (!user.authToken) continue;
      // Atomic claim — only one worker wins the PENDING→SENDING transition.
      const claimed = await this.prisma.scheduledMessage.updateMany({
        where: { id: msg.id, status: 'PENDING' },
        data: { status: 'SENDING' },
      });
      if (claimed.count === 0) continue;
      try {
        await this.resolver.forUser(user).sendMessage(buildMailSession(user), {
          to: msg.to as string[],
          cc: (msg.cc as string[]) ?? [],
          bcc: (msg.bcc as string[]) ?? [],
          subject: msg.subject ?? '',
          body: msg.body ?? '',
        });
        await this.prisma.scheduledMessage.updateMany({
          where: { id: msg.id, status: 'SENDING' },
          data: { status: 'SENT' },
        });
        await this.notifications.createNotification(
          msg.userId,
          'SCHEDULED_SENT',
          `Scheduled message sent: ${msg.subject ?? '(no subject)'}`,
          `To: ${(msg.to as string[]).join(', ')}`,
        ).catch(() => {});
      } catch (err: any) {
        this.logger.warn(`Scheduled message ${msg.id} failed: ${err?.message}`);
        await this.prisma.scheduledMessage.updateMany({
          where: { id: msg.id, status: 'SENDING' },
          data: { status: 'FAILED', errorMsg: err?.message ?? 'Unknown error' },
        });
      }
    }
  }

  // ─── Email Templates ─────────────────────────────────────────────────────────

  async getTemplates(userId: string) {
    await this.getUser(userId);
    return this.prisma.emailTemplate.findMany({ where: { userId }, orderBy: { name: 'asc' } });
  }

  async createTemplate(userId: string, data: { name: string; subject?: string; body: string }) {
    await this.getUser(userId);
    return this.prisma.emailTemplate.create({ data: { userId, name: data.name, subject: data.subject, body: data.body } });
  }

  async updateTemplate(userId: string, id: string, data: { name?: string; subject?: string; body?: string }) {
    const tmpl = await this.prisma.emailTemplate.findFirst({ where: { userId, id } });
    if (!tmpl) throw new NotFoundException('Template not found');
    return this.prisma.emailTemplate.update({ where: { id }, data });
  }

  async deleteTemplate(userId: string, id: string) {
    const tmpl = await this.prisma.emailTemplate.findFirst({ where: { userId, id } });
    if (!tmpl) throw new NotFoundException('Template not found');
    await this.prisma.emailTemplate.delete({ where: { id } });
    return { success: true };
  }

  // ─── Mail Rules ──────────────────────────────────────────────────────────────

  async getRules(userId: string) {
    await this.getUser(userId);
    return this.prisma.mailRule.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  }

  async createRule(userId: string, data: { name: string; enabled?: boolean; conditions: any[]; actions: any[] }) {
    await this.getUser(userId);
    return this.prisma.mailRule.create({
      data: { userId, name: data.name, enabled: data.enabled ?? true, conditions: data.conditions, actions: data.actions },
    });
  }

  async updateRule(userId: string, id: string, data: Partial<{ name: string; enabled: boolean; conditions: any[]; actions: any[] }>) {
    const rule = await this.prisma.mailRule.findFirst({ where: { userId, id } });
    if (!rule) throw new NotFoundException('Rule not found');
    return this.prisma.mailRule.update({ where: { id }, data });
  }

  async deleteRule(userId: string, id: string) {
    const rule = await this.prisma.mailRule.findFirst({ where: { userId, id } });
    if (!rule) throw new NotFoundException('Rule not found');
    await this.prisma.mailRule.delete({ where: { id } });
    return { success: true };
  }

  // ─── Sender Rules (Blocked / Allowed) ───────────────────────────────────────

  async getSenderRules(userId: string) {
    await this.getUser(userId);
    return this.prisma.senderRule.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  }

  async createSenderRule(userId: string, dto: { type: 'BLOCK' | 'ALLOW'; address: string }) {
    await this.getUser(userId);
    return this.prisma.senderRule.create({
      data: { userId, type: dto.type, address: dto.address.trim().toLowerCase() },
    });
  }

  async deleteSenderRule(userId: string, id: string) {
    const rule = await this.prisma.senderRule.findFirst({ where: { userId, id } });
    if (!rule) throw new NotFoundException('Sender rule not found');
    await this.prisma.senderRule.delete({ where: { id } });
    return { success: true };
  }

  // ─── Mute Conversation ───────────────────────────────────────────────────────

  async muteConversation(userId: string, conversationId: string) {
    await this.getUser(userId);
    await this.prisma.mutedConversation.upsert({
      where: { userId_conversationId: { userId, conversationId } },
      create: { userId, conversationId },
      update: {},
    });
    return { success: true, muted: true };
  }

  async unmuteConversation(userId: string, conversationId: string) {
    await this.prisma.mutedConversation.deleteMany({ where: { userId, conversationId } });
    return { success: true, muted: false };
  }

  async getMutedConversations(userId: string) {
    await this.getUser(userId);
    const muted = await this.prisma.mutedConversation.findMany({ where: { userId } });
    return muted.map((m) => m.conversationId);
  }

  // ─── Bulk Operations ─────────────────────────────────────────────────────────

  async bulkMarkRead(userId: string, messageIds: string[], read: boolean) {
    const user = await this.getUser(userId);
    const provider = this.resolver.forUser(user);
    const session = buildMailSession(user);
    const results: { id: string; success: boolean }[] = [];
    for (const messageId of messageIds) {
      try {
        const msg = await this.prisma.message.findFirst({ where: { userId, id: messageId } });
        if (!msg) { results.push({ id: messageId, success: false }); continue; }
        await provider.markRead(session, msg.zimbraId, read);
        await this.prisma.message.update({ where: { id: messageId }, data: { isRead: read } });
        results.push({ id: messageId, success: true });
      } catch { results.push({ id: messageId, success: false }); }
    }
    return { results };
  }

  async bulkDelete(userId: string, messageIds: string[]) {
    const user = await this.getUser(userId);
    const provider = this.resolver.forUser(user);
    const session = buildMailSession(user);
    const results: { id: string; success: boolean }[] = [];
    for (const messageId of messageIds) {
      try {
        const msg = await this.prisma.message.findFirst({ where: { userId, id: messageId } });
        if (!msg) { results.push({ id: messageId, success: false }); continue; }
        await provider.deleteMessage(session, msg.zimbraId);
        await this.prisma.message.delete({ where: { id: messageId } });
        results.push({ id: messageId, success: true });
      } catch { results.push({ id: messageId, success: false }); }
    }
    return { results };
  }

  async bulkMove(userId: string, messageIds: string[], targetFolderId: string) {
    const user = await this.getUser(userId);
    const provider = this.resolver.forUser(user);
    const session = buildMailSession(user);
    const targetFolder = await this.prisma.folder.findFirst({ where: { userId, id: targetFolderId } });
    if (!targetFolder) throw new NotFoundException('Target folder not found');
    const results: { id: string; success: boolean }[] = [];
    for (const messageId of messageIds) {
      try {
        const msg = await this.prisma.message.findFirst({ where: { userId, id: messageId } });
        if (!msg) { results.push({ id: messageId, success: false }); continue; }
        await provider.moveMessage(session, msg.zimbraId, targetFolder.zimbraId);
        await this.prisma.message.update({ where: { id: messageId }, data: { folderId: targetFolderId } });
        results.push({ id: messageId, success: true });
      } catch { results.push({ id: messageId, success: false }); }
    }
    return { results };
  }

  // ── Triage cards (read paths) ─────────────────────────────────────────────

  /** Batch label lookup for a set of message ids, scoped to the caller and excluding tombstones. */
  async getCardsByIds(
    userId: string,
    ids: string[],
  ): Promise<{ cards: Record<string, { label: TriageLabel; importance: string; injectionSuspected: boolean }> }> {
    if (ids.length > MAX_CARD_IDS) {
      throw new BadRequestException(`Too many ids (max ${MAX_CARD_IDS})`);
    }
    if (ids.length === 0) return { cards: {} };

    const rows = await this.prisma.messageCard.findMany({
      where: { userId, messageId: { in: ids }, failed: false },
    });

    const cards: Record<string, { label: TriageLabel; importance: string; injectionSuspected: boolean }> = {};
    for (const row of rows as any[]) {
      cards[row.messageId] = {
        label: deriveLabel({
          asksOfMe: row.asksOfMe as string[],
          waitingOn: row.waitingOn,
          deadlines: row.deadlines as string[],
        }),
        importance: row.importance,
        injectionSuspected: row.injectionSuspected,
      };
    }
    return { cards };
  }

  private windowCutoff(window: CardWindow): Date {
    if (window === 'today') {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d;
    }
    if (window === '24h') return new Date(Date.now() - 24 * 60 * 60 * 1000);
    return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  }

  private toExtractedCard(row: WindowCardRow): ExtractedCard {
    const msg = row.message;
    return {
      messageId: row.messageId,
      conversationId: msg.conversationId,
      direction: msg.folder?.path === '/Sent' ? 'sent' : 'received',
      from: msg.fromName ? `${msg.fromName} <${msg.fromEmail}>` : msg.fromEmail,
      subject: msg.subject,
      receivedAt: msg.receivedAt.toISOString(),
      gist: row.gist,
      asksOfMe: row.asksOfMe as string[],
      deadlines: row.deadlines as string[],
      commitmentsIMade: row.commitmentsIMade as string[],
      waitingOn: row.waitingOn,
      importance: row.importance as ExtractedCard['importance'],
      attachments: formatAttachments(msg.attachments),
      injectionSuspected: row.injectionSuspected,
    };
  }

  /** Full cards for the caller's Inbox+Sent within a time window, newest first, capped, tombstones excluded. */
  async getWindowCards(userId: string, window: string): Promise<{ cards: ExtractedCard[] }> {
    if (!(CARD_WINDOWS as readonly string[]).includes(window)) {
      throw new BadRequestException(`Invalid window (expected one of ${CARD_WINDOWS.join(', ')})`);
    }

    const gte = this.windowCutoff(window as CardWindow);

    const rows = (await this.prisma.messageCard.findMany({
      where: {
        userId,
        failed: false,
        message: {
          receivedAt: { gte },
          folder: { path: { in: CARD_FOLDER_PATHS } },
        },
      },
      include: { message: { include: { folder: true } } },
      orderBy: { message: { receivedAt: 'desc' } },
      take: MAX_WINDOW_CARDS,
    })) as unknown as WindowCardRow[];

    return { cards: rows.map((row) => this.toExtractedCard(row)) };
  }

  // ── Commitments ledger ──────────────────────────────────────────────────────

  /** Batch-resolve from-labels for a set of source message ids. Missing rows map to null. */
  private async counterpartiesFor(userId: string, messageIds: string[]): Promise<Map<string, string>> {
    if (messageIds.length === 0) return new Map();
    const messages = await this.prisma.message.findMany({
      where: { id: { in: messageIds }, userId },
      select: { id: true, fromName: true, fromEmail: true },
    });
    const map = new Map<string, string>();
    for (const m of messages as any[]) {
      map.set(m.id, m.fromName ? `${m.fromName} <${m.fromEmail}>` : m.fromEmail);
    }
    return map;
  }

  /** Grouped, user-scoped commitment ledger. `openCount` always reflects status='open'. */
  async getCommitments(
    userId: string,
    status: string,
  ): Promise<{ promised: CommitmentDto[]; waiting: CommitmentDto[]; openCount: number }> {
    if (!(COMMITMENT_STATUS_FILTERS as readonly string[]).includes(status)) {
      throw new BadRequestException(`Invalid status (expected one of ${COMMITMENT_STATUS_FILTERS.join(', ')})`);
    }

    const where =
      (status as CommitmentStatusFilter) === 'open'
        ? { userId, status: 'open' }
        : { userId, status: 'archived' };

    const [rows, openCount] = await Promise.all([
      this.prisma.commitment.findMany({
        where,
        orderBy: { lastActivityAt: 'desc' },
        take: MAX_COMMITMENTS,
      }),
      this.prisma.commitment.count({ where: { userId, status: 'open' } }),
    ]);

    const counterparties = await this.counterpartiesFor(userId, [...new Set((rows as any[]).map((r) => r.messageId))]);

    const toDto = (row: any): CommitmentDto => {
      const { userId: _userId, textHash: _textHash, ...rest } = row;
      return { ...rest, counterparty: counterparties.get(row.messageId) ?? null };
    };

    const promised = (rows as any[]).filter((r) => r.type === 'promised').map(toDto);
    const waiting = (rows as any[]).filter((r) => r.type === 'waiting').map(toDto);

    return { promised, waiting, openCount };
  }

  /** Human resolution/reopen. Always clears `suggestResolve`; sets/nulls `resolvedAt`.
   * Returns the updated row (minus userId/textHash) — the web `request<T>` helper
   * calls `res.json()` unconditionally, which rejects on an empty body, so the
   * PATCH response must carry something even though callers currently ignore it.
   */
  async updateCommitment(userId: string, id: string, status: string): Promise<CommitmentRow> {
    if (!(COMMITMENT_UPDATE_STATUSES as readonly string[]).includes(status)) {
      throw new BadRequestException(`Invalid status (expected one of ${COMMITMENT_UPDATE_STATUSES.join(', ')})`);
    }

    const commitment = await this.prisma.commitment.findUnique({ where: { id } });
    if (!commitment || commitment.userId !== userId) throw new NotFoundException('Commitment not found');
    // Promoted rows are terminal in the ledger — the linked Task is now authoritative.
    // Allowing a transition here would leave a stale taskId and enable re-promotion
    // (duplicate Task) via a second POST .../promote call.
    if (commitment.status === 'promoted') {
      throw new ConflictException('A promoted commitment cannot be resolved or reopened here');
    }

    const updated = await this.prisma.commitment.update({
      where: { id },
      data: {
        status,
        resolvedAt: (status as CommitmentUpdateStatus) === 'open' ? null : new Date(),
        suggestResolve: false,
      },
    });

    const { userId: _userId, textHash: _textHash, ...rest } = updated as any;
    return rest;
  }

  /** Promotes an open commitment to a real Task; the ledger row is then a historical pointer.
   * `overrides` (all optional) let the caller override title/description/dueDate/priority on
   * the created Task — an empty/absent body preserves the prior default derivation. */
  async promoteCommitment(
    userId: string,
    id: string,
    overrides?: PromoteCommitmentDto,
  ): Promise<{ taskId: string; task: Awaited<ReturnType<TasksService['create']>> }> {
    const commitment = await this.prisma.commitment.findUnique({ where: { id } });
    if (!commitment || commitment.userId !== userId) throw new NotFoundException('Commitment not found');
    if (commitment.status !== 'open') throw new ConflictException('Only an open commitment can be promoted');

    const sourceMessage = await this.prisma.message.findFirst({
      where: { id: commitment.messageId, userId },
      select: { subject: true },
    });

    const task = await this.tasksService.create(userId, {
      title: overrides?.title?.trim() || commitment.text,
      description: overrides?.description ?? `${commitment.dueHint ? `Due hint: ${commitment.dueHint}. ` : ''}Extracted from email.`,
      dueDate: overrides?.dueDate,
      priority: overrides?.priority,
      linkedMessageId: commitment.messageId,
      linkedSubject: sourceMessage?.subject ?? undefined,
    });

    try {
      await this.prisma.commitment.update({
        where: { id },
        data: { status: 'promoted', taskId: task.id, resolvedAt: new Date() },
      });
    } catch (err) {
      // Saga-style compensation: the Task was already created, but the ledger
      // write that records it failed. Leaving the Task orphaned would let a
      // retry of this endpoint create a second, duplicate Task for the same
      // commitment — best-effort delete it, then rethrow so the caller still
      // sees the failure.
      await this.prisma.task.delete({ where: { id: task.id } }).catch(() => {});
      throw err;
    }

    return { taskId: task.id, task };
  }
}
