import { Injectable, NotFoundException, Logger, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ZimbraService } from '../zimbra/zimbra.service';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly zimbra: ZimbraService,
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

    const hasZimbraImages = rawBodyHtml?.includes('/service/home/') ?? false;
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

    const { messages, total } = await this.zimbra.searchMessages(
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

    return { messages: saved, total, offset, limit, hasMore: offset + messages.length < total };
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

    // Strip embedded base64 data URIs from the outgoing body.
    // When a user replies to a thread, the quoted body may contain images we
    // previously embedded as data URIs for display.  Those URIs are meaningless
    // to the recipient and inflate the payload well beyond 10 MB.
    const cleanBody = payload.body.replace(
      /src=["']data:[^"']*["']/gi,
      'src=""',
    );

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

    await this.zimbra.sendMessage(
      user.zimbraHost,
      user.authToken!,
      { ...payload, body: cleanBody, replyToId: zimbraReplyToId },
      user.csrfToken ?? undefined,
      attachmentAids,
    );
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
            const esc     = img.cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
   * Find every <img src="https://{zimbraHost}/service/home/...?id=X&part=Y">
   * in the HTML, download the image server-side (with the user's auth token),
   * and replace the src with a base64 data URI.  This handles signature images
   * that are stored in the user's Zimbra Briefcase rather than as CID attachments.
   */
  private async embedZimbraHostedImages(
    html: string,
    user: { zimbraHost: string; authToken: string | null; email: string },
  ): Promise<string> {
    if (!user.authToken) return html;

    const escapedHost = user.zimbraHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match src attributes pointing to this Zimbra server's /service/home/ endpoint
    const urlRe = new RegExp(
      `src=["'](https?://${escapedHost}/service/home/[^?"']*\\?[^"']*)["']`,
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
          if (!id || !part) return;

          const { data, contentType } = await this.zimbra.downloadAttachmentBuffer(
            user.zimbraHost,
            user.authToken!,
            user.email,
            id,
            part,
          );
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
    return { success: true };
  }
}
