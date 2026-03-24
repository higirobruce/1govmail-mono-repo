import { Injectable, NotFoundException, Logger, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ZimbraService } from '../zimbra/zimbra.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly zimbra: ZimbraService,
    private readonly notifications: NotificationsService,
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

  private zimbraViewToType(view?: string): 'MAIL' | 'CONTACTS' | 'CALENDAR' | 'TASKS' | 'BRIEFCASE' {
    switch (view) {
      case 'contact':     return 'CONTACTS';
      case 'appointment': return 'CALENDAR';
      case 'task':        return 'TASKS';
      case 'document':    return 'BRIEFCASE';
      default:            return 'MAIL';
    }
  }

  async getFolders(userId: string) {
    const user = await this.getUser(userId);

    let zimbraFolders;
    try {
      zimbraFolders = await this.zimbra.getFolders(user.zimbraHost, user.authToken!, user.csrfToken ?? undefined);
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

    // Persist folders to DB for caching; failures here must not prevent the
    // response from reaching the client (don't let a Prisma error become 500).
    const saved: any[] = [];
    for (const f of zimbraFolders) {
      try {
        const folderType = this.zimbraViewToType(f.view);
        const folder = await this.prisma.folder.upsert({
          where: { userId_zimbraId: { userId, zimbraId: f.id } },
          update: {
            name: f.name,
            path: f.absFolderPath,
            type: folderType,
            unreadCount: f.u ?? 0,
            totalCount: f.n ?? 0,
            syncedAt: new Date(),
          },
          create: {
            userId,
            zimbraId: f.id,
            name: f.name,
            path: f.absFolderPath,
            type: folderType,
            parentId: f.l ?? null,
            unreadCount: f.u ?? 0,
            totalCount: f.n ?? 0,
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

  async getMessages(userId: string, folderId: string, limit = 50, offset = 0) {
    const user = await this.getUser(userId);

    const folder = await this.prisma.folder.findFirst({
      where: { userId, id: folderId },
    });
    if (!folder) throw new NotFoundException('Folder not found');

    const { messages, total, more } = await this.zimbra.getMessages(
      user.zimbraHost,
      user.authToken!,
      folder.zimbraId,
      limit,
      offset,
      user.csrfToken ?? undefined,
    );

    const saved: any[] = [];
    for (const m of messages) {
      try {
        const fromAddr = m.e?.find((e) => e.t === 'f');
        const toAddrs = (m.e ?? []).filter((e) => e.t === 't').map((e) => ({ email: e.a, name: e.d }));
        const flags = m.f ?? '';
        const zimbraId = String(m.id);   // Zimbra may return numeric IDs

        const msg = await this.prisma.message.upsert({
          where: { userId_zimbraId: { userId, zimbraId } },
          update: {
            isRead:    !flags.includes('u'),
            isStarred:  flags.includes('f'),
            isDraft:    flags.includes('d'),
            syncedAt:   new Date(),
          },
          create: {
            userId,
            folderId,
            zimbraId,
            conversationId: m.cid != null ? String(m.cid) : null,
            subject:        m.su ?? null,
            snippet:        m.fr ?? null,
            fromEmail:      fromAddr?.a ?? '',
            fromName:       fromAddr?.d ?? null,
            toRecipients:   toAddrs,
            isRead:         !flags.includes('u'),
            isStarred:       flags.includes('f'),
            isDraft:         flags.includes('d'),
            hasAttachments:  flags.includes('a'),
            receivedAt:      new Date(m.d),
          },
        });
        // Strip large body fields — the list view only needs metadata.
        // Returning bodyHtml with embedded base64 images for 50 messages at
        // once can exceed V8's string length limit in JSON.stringify.
        const { bodyHtml: _bh, bodyText: _bt, inlineImages: _ii, attachments: _att, ...msgMeta } = msg as any;
        saved.push(msgMeta);
      } catch (err: any) {
        this.logger.error(`Failed to upsert message zimbraId=${m.id}: ${err?.message}`);
      }
    }

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
    // (null = never fetched), and bodyHtml has no un-embedded cid: refs.
    const attachmentsCached = Array.isArray(cached?.attachments) && (cached.attachments as any[]).length >= 0;
    const bodyHasCids = (cached?.bodyHtml ?? '').includes('cid:');
    const bodyHasZimbraUrls = (cached?.bodyHtml ?? '').includes('/service/home/');
    if ((cached?.bodyHtml || cached?.bodyText) && attachmentsCached && cached?.inlineImages !== null && !bodyHasCids && !bodyHasZimbraUrls) {
      return cached;
    }

    const m = await this.zimbra.getMessage(
      user.zimbraHost,
      user.authToken!,
      cached?.zimbraId ?? messageId,
      user.csrfToken ?? undefined,
    );

    const rawBodyHtml  = this.extractBody(m.mp ?? [], 'text/html');
    const bodyText     = this.extractBody(m.mp ?? [], 'text/plain');
    const attachments  = this.extractAttachments(m.mp ?? []);
    const inlineImages = this.extractInlineImages(m.mp ?? []);

    // Extract full recipient info from the fetched message
    const ccRecipients = (m.e ?? [])
      .filter((e) => e.t === 'c')
      .map((e) => ({ email: e.a, name: e.d ?? null }));

    // Embed inline images with a time budget.
    // - If Zimbra responds quickly (< 5 s): return fully embedded HTML immediately.
    // - If slow: return raw HTML now and finish embedding in the background so the
    //   next open returns the cached, fully embedded version instantly.
    // 5 s (up from 2 s) because on-premise Zimbra servers regularly take 3–7 s to
    // serve attachment buffers over an internal network.
    const EMBED_BUDGET_MS = 5_000;
    let bodyHtml = rawBodyHtml;

    // Detect any src attribute pointing to the Zimbra host — covers
    // /service/home/ (inline attachments), /service/proxy/ (image proxy for
    // external images), /home/ briefcase paths, and other Zimbra REST URLs.
    const zimbraHostPattern = new RegExp(
      `src=["']https?://${user.zimbraHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`,
      'i',
    );
    const hasZimbraImages = rawBodyHtml ? zimbraHostPattern.test(rawBodyHtml) : false;
    if (rawBodyHtml && (inlineImages.length > 0 || hasZimbraImages)) {
      const embedTask = this.embedInlineImages(rawBodyHtml, inlineImages, user, String(m.id));
      const raceResult = await Promise.race([
        embedTask.then((html) => ({ html, done: true as const })),
        new Promise<{ html: null; done: false }>((r) =>
          setTimeout(() => r({ html: null, done: false }), EMBED_BUDGET_MS),
        ),
      ]);

      if (raceResult.done) {
        // Images loaded within budget — use the embedded version
        bodyHtml = raceResult.html;
      } else {
        // Timed out — warm the cache in the background; next open will be instant.
        // Use updateMany keyed on zimbraId so this works whether the DB record was
        // pre-existing (folder-listed message) or newly upserted below (search result).
        void embedTask
          .then((embeddedHtml) =>
            this.prisma.message.updateMany({
              where: { userId, zimbraId: String(m.id) },
              data:  { bodyHtml: embeddedHtml },
            }),
          )
          .catch((err: any) =>
            this.logger.error(`[getMessage] background embed failed: ${err?.message}`),
          );
      }
    }

    let result: any;
    if (cached) {
      result = await this.prisma.message.update({
        where: { id: cached.id },
        data: { bodyHtml, bodyText, attachments, inlineImages, hasAttachments: attachments.length > 0, ccRecipients },
      });
    } else {
      // Message is not in DB yet (e.g. opened from search results before the folder
      // was synced). Attempt to upsert so that subsequent opens are served from cache
      // and the background embed above can update the record via zimbraId.
      const zimbraFolderId = String(m.l);
      const folder = await this.prisma.folder.findFirst({ where: { userId, zimbraId: zimbraFolderId } });
      const fromAddr = (m.e ?? []).find((e: any) => e.t === 'f');
      const toAddrs  = (m.e ?? []).filter((e: any) => e.t === 't').map((e: any) => ({ email: e.a, name: e.d }));
      const flags    = m.f ?? '';

      if (folder) {
        result = await this.prisma.message.upsert({
          where:  { userId_zimbraId: { userId, zimbraId: String(m.id) } },
          create: {
            userId,
            folderId:       folder.id,
            zimbraId:       String(m.id),
            subject:        m.su  ?? null,
            snippet:        null,
            fromEmail:      fromAddr?.a ?? '',
            fromName:       fromAddr?.d ?? null,
            toRecipients:   toAddrs,
            ccRecipients,
            isRead:         !flags.includes('u'),
            isStarred:      flags.includes('f'),
            isDraft:        flags.includes('d'),
            hasAttachments: attachments.length > 0,
            attachments,
            inlineImages,
            bodyHtml,
            bodyText,
            receivedAt:     new Date(m.d),
          },
          update: {
            bodyHtml,
            bodyText,
            attachments,
            inlineImages,
            hasAttachments: attachments.length > 0,
            ccRecipients,
          },
        });
      } else {
        // Folder not yet synced — return ephemeral object (no caching possible).
        result = { bodyHtml, bodyText, attachments, inlineImages, hasAttachments: attachments.length > 0, ccRecipients };
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

    // Back-fill conversation messages not yet in the local DB by querying Zimbra.
    // This ensures the full thread history is visible when a user was CC'd mid-thread
    // or when older messages haven't been reached by the incremental folder sync yet.
    try {
      const user = await this.getUser(userId);

      // Find zimbraIds already in the DB for this conversation to avoid re-fetching
      const existing = await this.prisma.message.findMany({
        where: { userId, conversationId: msg.conversationId },
        select: { zimbraId: true },
      });
      const existingZimbraIds = new Set(existing.map((m) => m.zimbraId));

      const { messages: zimbraMsgs } = await this.zimbra.searchMessages(
        user.zimbraHost,
        user.authToken!,
        `conv:${msg.conversationId}`,
        200,
        0,
        user.csrfToken ?? undefined,
      );

      // Build a folder zimbraId → DB folder map so we avoid per-message DB lookups
      const folders = await this.prisma.folder.findMany({
        where: { userId },
        select: { id: true, zimbraId: true },
      });
      const folderByZimbraId = new Map(folders.map((f) => [f.zimbraId, f.id]));

      for (const m of zimbraMsgs) {
        const zimbraId = String(m.id);
        if (existingZimbraIds.has(zimbraId)) continue; // already synced

        try {
          const fromAddr    = m.e?.find((e) => e.t === 'f');
          const toAddrs     = (m.e ?? []).filter((e) => e.t === 't').map((e) => ({ email: e.a, name: e.d ?? null }));
          const ccAddrs     = (m.e ?? []).filter((e) => e.t === 'c').map((e) => ({ email: e.a, name: e.d ?? null }));
          const flags       = m.f ?? '';
          const folderId    = folderByZimbraId.get(String(m.l));

          if (!folderId) continue; // folder not yet synced — skip

          await this.prisma.message.upsert({
            where:  { userId_zimbraId: { userId, zimbraId } },
            create: {
              userId,
              folderId,
              zimbraId,
              conversationId: msg.conversationId,
              subject:        m.su  ?? null,
              snippet:        m.fr  ?? null,
              fromEmail:      fromAddr?.a ?? '',
              fromName:       fromAddr?.d ?? null,
              toRecipients:   toAddrs,
              ccRecipients:   ccAddrs,
              isRead:         !flags.includes('u'),
              isStarred:       flags.includes('f'),
              isDraft:         flags.includes('d'),
              hasAttachments:  flags.includes('a'),
              receivedAt:      new Date(m.d),
            },
            update: {
              isRead:    !flags.includes('u'),
              isStarred:  flags.includes('f'),
              isDraft:    flags.includes('d'),
              syncedAt:   new Date(),
            },
          });
        } catch (err: any) {
          this.logger.warn(`[getConversation] failed to upsert zimbraId=${m.id}: ${err?.message}`);
        }
      }
    } catch (err: any) {
      // Back-fill is best-effort — a Zimbra outage must not break the thread view
      this.logger.warn(`[getConversation] Zimbra back-fill failed: ${err?.message}`);
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

    const { messages, total, more } = await this.zimbra.searchMessages(
      user.zimbraHost,
      user.authToken!,
      query,
      limit,
      offset,
      user.csrfToken ?? undefined,
    );

    // Map Zimbra results → shape the client already knows, upsert to DB where possible
    const saved: any[] = [];
    for (const m of messages) {
      try {
        const fromAddr = m.e?.find((e) => e.t === 'f');
        const toAddrs  = (m.e ?? []).filter((e) => e.t === 't').map((e) => ({ email: e.a, name: e.d }));
        const flags    = m.f ?? '';
        const zimbraId = String(m.id);

        // Find the synced folder in DB (may be absent if not yet synced)
        const folder = await this.prisma.folder.findFirst({
          where: { userId, zimbraId: String(m.l) },
        });

        if (folder) {
          // Persist / update so the message is fetchable by DB id later
          const msg = await this.prisma.message.upsert({
            where:  { userId_zimbraId: { userId, zimbraId } },
            update: { isRead: !flags.includes('u'), isStarred: flags.includes('f'), syncedAt: new Date() },
            create: {
              userId,
              folderId:      folder.id,
              zimbraId,
              conversationId: m.cid != null ? String(m.cid) : null,
              subject:        m.su  ?? null,
              snippet:        m.fr  ?? null,
              fromEmail:      fromAddr?.a ?? '',
              fromName:       fromAddr?.d ?? null,
              toRecipients:   toAddrs,
              isRead:         !flags.includes('u'),
              isStarred:      flags.includes('f'),
              hasAttachments: flags.includes('a'),
              receivedAt:     new Date(m.d),
            },
          });
          saved.push(msg);
        } else {
          // Folder not synced yet — return a lightweight ephemeral result
          saved.push({
            id:            zimbraId, // use zimbraId as id so getMessage falls back correctly
            zimbraId,
            subject:        m.su ?? null,
            snippet:        m.fr ?? null,
            fromEmail:      fromAddr?.a ?? '',
            fromName:       fromAddr?.d ?? null,
            toRecipients:   toAddrs,
            isRead:         !flags.includes('u'),
            isStarred:      flags.includes('f'),
            hasAttachments: flags.includes('a'),
            receivedAt:     new Date(m.d),
            tags:           [],
          });
        }
      } catch (err: any) {
        this.logger.error(`Search upsert failed for zimbraId=${m.id}: ${err?.message}`);
      }
    }

    return { messages: saved, total, offset, limit, hasMore: more };
  }

  async downloadAttachment(userId: string, messageId: string, partId: string) {
    const user = await this.getUser(userId);

    const msg = await this.prisma.message.findFirst({ where: { userId, id: messageId } });
    if (!msg) throw new NotFoundException('Message not found');

    return this.zimbra.downloadAttachment(
      user.zimbraHost,
      user.authToken!,
      user.email,
      msg.zimbraId,
      partId,
    );
  }

  async sendMessage(
    userId: string,
    payload: {
      to: string[];
      cc?: string[];
      bcc?: string[];
      subject: string;
      body: string;
      replyToId?: string;
      replyType?: 'r' | 'w';
      forwardedAttachments?: Array<{ mid: string; part: string }>;
    },
    files: Express.Multer.File[] = [],
  ) {
    const user = await this.getUser(userId);

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
          const aid = await this.zimbra.uploadAttachment(
            user.zimbraHost,
            user.authToken!,
            buf,
            `inline.${ext}`,
            img.contentType,
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
          this.zimbra.uploadAttachment(
            user.zimbraHost,
            user.authToken!,
            f.buffer,
            f.originalname,
            f.mimetype,
          ),
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

    const { zimbraId: sentZimbraId, conversationId: sentCid } =
      await this.zimbra.sendMessage(
        user.zimbraHost,
        user.authToken!,
        { ...payload, body: cleanBody, replyToId: zimbraReplyToId },
        user.csrfToken ?? undefined,
        attachmentAids,
        inlineImageAids,
        resolvedForwardedAttachments,
      );

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

    await this.zimbra.deleteMessage(user.zimbraHost, user.authToken!, msg.zimbraId, user.csrfToken ?? undefined);
    await this.prisma.message.delete({ where: { id: messageId } });
    return { success: true };
  }

  async markRead(userId: string, messageId: string, read: boolean) {
    const user = await this.getUser(userId);
    const msg = await this.prisma.message.findFirst({ where: { userId, id: messageId } });
    if (!msg) throw new NotFoundException('Message not found');

    await this.zimbra.markRead(user.zimbraHost, user.authToken!, msg.zimbraId, read, user.csrfToken ?? undefined);
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
    user: { zimbraHost: string; authToken: string | null; email: string },
    zimbraMessageId: string,
  ): Promise<string> {
    let processed = html;

    // ── Pass 1: CID inline attachments ────────────────────────────────────────
    if (inlineImages.length > 0) {
      await Promise.all(
        inlineImages.map(async (img) => {
          try {
            const { data, contentType } = await this.zimbra.downloadAttachmentBuffer(
              user.zimbraHost,
              user.authToken!,
              user.email,
              String(zimbraMessageId),
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
    user: { zimbraHost: string; authToken: string | null; email: string },
  ): Promise<string> {
    if (!user.authToken) return html;

    const escapedHost = user.zimbraHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
            ({ data, contentType } = await this.zimbra.downloadAttachmentBuffer(
              user.zimbraHost,
              user.authToken!,
              user.email,
              id,
              part,
            ));
          } else {
            // Path-based URL (Briefcase image, image-proxy, or other Zimbra resource)
            // downloadZimbraPath appends ?auth=qp&zauthtoken=... for query-param auth
            const relativePath = parsed.pathname + (parsed.search || '');
            ({ data, contentType } = await this.zimbra.downloadZimbraPath(
              user.zimbraHost,
              user.authToken!,
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

  private extractBody(parts: any[], contentType: string): string | null {
    for (const part of parts) {
      if (part.ct === contentType && part.body) return part.content ?? null;
      if (part.mp) {
        const found = this.extractBody(part.mp, contentType);
        if (found) return found;
      }
    }
    return null;
  }

  /** Recursively collect non-body parts that carry a filename (attachments). */
  private extractAttachments(
    parts: any[],
  ): Array<{ id: string; filename: string; mimeType: string; size: number }> {
    const result: Array<{ id: string; filename: string; mimeType: string; size: number }> = [];
    for (const part of parts) {
      // A part is an attachment when it has a filename and is not the inline body
      if (part.filename && !part.body) {
        result.push({
          id:       String(part.part),
          filename: part.filename,
          mimeType: part.ct ?? 'application/octet-stream',
          size:     part.s ?? 0,
        });
      }
      if (part.mp) result.push(...this.extractAttachments(part.mp));
    }
    return result;
  }

  /** Collect inline image parts (CID-referenced, e.g. email signatures). */
  private extractInlineImages(
    parts: any[],
  ): Array<{ cid: string; partId: string; mimeType: string }> {
    const result: Array<{ cid: string; partId: string; mimeType: string }> = [];
    for (const part of parts) {
      // Inline images have a content-id (ci) and image/* mime type and are not the main body
      if (part.ci && part.ct?.startsWith('image/') && !part.body) {
        result.push({
          cid:      part.ci.replace(/^<|>$/g, ''), // strip angle brackets
          partId:   String(part.part),
          mimeType: part.ct,
        });
      }
      if (part.mp) result.push(...this.extractInlineImages(part.mp));
    }
    return result;
  }

  /** Recursively flatten all MIME parts into a single array (for debug/inspection). */
  private flattenParts(parts: any[]): any[] {
    const result: any[] = [];
    for (const part of parts) {
      result.push(part);
      if (part.mp) result.push(...this.flattenParts(part.mp));
    }
    return result;
  }

  async moveMessage(userId: string, messageId: string, targetFolderOurId: string) {
    const user = await this.getUser(userId);

    const message = await this.prisma.message.findFirst({ where: { userId, id: messageId } });
    if (!message) throw new NotFoundException('Message not found');

    const targetFolder = await this.prisma.folder.findFirst({ where: { userId, id: targetFolderOurId } });
    if (!targetFolder) throw new NotFoundException('Target folder not found');

    await this.zimbra.moveMessage(
      user.zimbraHost,
      user.authToken!,
      message.zimbraId,
      targetFolder.zimbraId,
      user.csrfToken ?? undefined,
    );

    await this.prisma.message.update({
      where: { id: messageId },
      data: { folderId: targetFolderOurId },
    });

    return { success: true };
  }

  async deleteFolder(userId: string, folderId: string) {
    const user = await this.getUser(userId);

    const folder = await this.prisma.folder.findFirst({
      where: { userId, id: folderId },
    });
    if (!folder) throw new NotFoundException('Folder not found');

    await this.zimbra.deleteFolder(
      user.zimbraHost,
      user.authToken!,
      folder.zimbraId,
      user.csrfToken ?? undefined,
    );

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

    await this.zimbra.emptyFolder(
      user.zimbraHost,
      user.authToken!,
      folder.zimbraId,
      user.csrfToken ?? undefined,
    );

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

    await this.zimbra.renameFolder(
      user.zimbraHost,
      user.authToken!,
      folder.zimbraId,
      name,
      user.csrfToken ?? undefined,
    );

    return this.prisma.folder.update({
      where: { id: folderId },
      data: { name, path: `/${name}` },
    });
  }

  async createFolder(userId: string, name: string) {
    const user = await this.getUser(userId);

    const zimbraFolder = await this.zimbra.createFolder(
      user.zimbraHost,
      user.authToken!,
      name,
      user.csrfToken ?? undefined,
    );

    const folder = await this.prisma.folder.upsert({
      where: { userId_zimbraId: { userId, zimbraId: zimbraFolder.id } },
      update: { name: zimbraFolder.name, path: zimbraFolder.absFolderPath, syncedAt: new Date() },
      create: {
        userId,
        zimbraId: zimbraFolder.id,
        name: zimbraFolder.name,
        path: zimbraFolder.absFolderPath,
        unreadCount: 0,
        totalCount: 0,
        syncedAt: new Date(),
      },
    });

    return folder;
  }

  // ─── Drafts ─────────────────────────────────────────────────────────────────

  /**
   * Save or update a Zimbra draft.
   * If `payload.draftId` is supplied, the existing draft is updated in-place;
   * otherwise a new draft is created in the Drafts folder.
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
      draftId?: string;
    },
  ): Promise<{ zimbraId: string }> {
    const user = await this.getUser(userId);
    const zimbraId = await this.zimbra.saveDraft(
      user.zimbraHost,
      user.authToken!,
      {
        id: payload.draftId,
        to: payload.to,
        cc: payload.cc,
        bcc: payload.bcc,
        subject: payload.subject,
        body: payload.body,
      },
      user.csrfToken ?? undefined,
    );
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
    await this.zimbra.deleteMessage(
      user.zimbraHost,
      user.authToken!,
      zimbraId,
      user.csrfToken ?? undefined,
    );
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
            await this.zimbra.moveMessage(user.zimbraHost, user.authToken, msg.zimbraId, targetFolder.zimbraId, user.csrfToken ?? undefined);
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
    return this.prisma.scheduledMessage.update({ where: { id }, data: { status: 'CANCELLED' } });
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
    const due = await this.prisma.scheduledMessage.findMany({
      where: { status: 'PENDING', sendAt: { lte: new Date() } },
      include: { user: true },
    });
    for (const msg of due) {
      const user = msg.user as any;
      if (!user.authToken) continue;
      try {
        await this.zimbra.sendMessage(
          user.zimbraHost,
          user.authToken,
          {
            to: msg.to as string[],
            cc: (msg.cc as string[]) ?? [],
            bcc: (msg.bcc as string[]) ?? [],
            subject: msg.subject ?? '',
            body: msg.body ?? '',
          },
          user.csrfToken ?? undefined,
        );
        await this.prisma.scheduledMessage.update({ where: { id: msg.id }, data: { status: 'SENT' } });
        await this.notifications.createNotification(
          msg.userId,
          'SCHEDULED_SENT',
          `Scheduled message sent: ${msg.subject ?? '(no subject)'}`,
          `To: ${(msg.to as string[]).join(', ')}`,
        ).catch(() => {});
      } catch (err: any) {
        this.logger.warn(`Scheduled message ${msg.id} failed: ${err?.message}`);
        await this.prisma.scheduledMessage.update({
          where: { id: msg.id },
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
    const results: { id: string; success: boolean }[] = [];
    for (const messageId of messageIds) {
      try {
        const msg = await this.prisma.message.findFirst({ where: { userId, id: messageId } });
        if (!msg) { results.push({ id: messageId, success: false }); continue; }
        await this.zimbra.markRead(user.zimbraHost, user.authToken!, msg.zimbraId, read, user.csrfToken ?? undefined);
        await this.prisma.message.update({ where: { id: messageId }, data: { isRead: read } });
        results.push({ id: messageId, success: true });
      } catch { results.push({ id: messageId, success: false }); }
    }
    return { results };
  }

  async bulkDelete(userId: string, messageIds: string[]) {
    const user = await this.getUser(userId);
    const results: { id: string; success: boolean }[] = [];
    for (const messageId of messageIds) {
      try {
        const msg = await this.prisma.message.findFirst({ where: { userId, id: messageId } });
        if (!msg) { results.push({ id: messageId, success: false }); continue; }
        await this.zimbra.deleteMessage(user.zimbraHost, user.authToken!, msg.zimbraId, user.csrfToken ?? undefined);
        await this.prisma.message.delete({ where: { id: messageId } });
        results.push({ id: messageId, success: true });
      } catch { results.push({ id: messageId, success: false }); }
    }
    return { results };
  }

  async bulkMove(userId: string, messageIds: string[], targetFolderId: string) {
    const user = await this.getUser(userId);
    const targetFolder = await this.prisma.folder.findFirst({ where: { userId, id: targetFolderId } });
    if (!targetFolder) throw new NotFoundException('Target folder not found');
    const results: { id: string; success: boolean }[] = [];
    for (const messageId of messageIds) {
      try {
        const msg = await this.prisma.message.findFirst({ where: { userId, id: messageId } });
        if (!msg) { results.push({ id: messageId, success: false }); continue; }
        await this.zimbra.moveMessage(user.zimbraHost, user.authToken!, msg.zimbraId, targetFolder.zimbraId, user.csrfToken ?? undefined);
        await this.prisma.message.update({ where: { id: messageId }, data: { folderId: targetFolderId } });
        results.push({ id: messageId, success: true });
      } catch { results.push({ id: messageId, success: false }); }
    }
    return { results };
  }
}
