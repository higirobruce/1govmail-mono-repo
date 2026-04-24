import { randomBytes } from 'crypto';

// 128 bits of entropy — infeasible to brute-force even against a leaked
// enumeration oracle. Encoded with a URL-safe charset so it can be put
// directly in a share URL without escaping.
function shortToken(): string {
  const CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = randomBytes(16);
  return Array.from(bytes, (b) => CHARS[b % CHARS.length]).join('');
}
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InviteRole, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ZimbraService } from '../zimbra/zimbra.service';
import { CreateDocDto } from './dto/create-doc.dto';
import { UpdateDocDto } from './dto/update-doc.dto';
import { CreateInviteDto } from './dto/create-invite.dto';
import { UpdateInviteDto } from './dto/update-invite.dto';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';
import { ReactCommentDto } from './dto/react-comment.dto';

@Injectable()
export class DocsService {
  private readonly logger = new Logger(DocsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly zimbra: ZimbraService,
  ) {}

  // ── Owned docs ────────────────────────────────────────────────────────────

  async findAll(userId: string) {
    return this.prisma.document.findMany({
      where: { userId },
      select: {
        id: true,
        title: true,
        emoji: true,
        parentId: true,
        position: true,
        isFavorite: true,
        tags: true,
        coverColor: true,
        shareToken: true,
        isShared: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ position: 'asc' }, { createdAt: 'desc' }],
    });
  }

  async findSharedWithMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user) return [];

    const invites = await this.prisma.documentInvite.findMany({
      where: { invitedEmail: user.email },
      include: {
        document: {
          select: {
            id: true,
            title: true,
            emoji: true,
            coverColor: true,
            tags: true,
            isShared: true,
            shareToken: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        inviter: {
          select: { displayName: true, email: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return invites.map((inv) => ({
      ...inv.document,
      _invite: {
        id: inv.id,
        role: inv.role,
        invitedByName: inv.inviter.displayName ?? inv.inviter.email,
        invitedByEmail: inv.inviter.email,
      },
    }));
  }

  async findOne(userId: string, id: string) {
    const doc = await this.prisma.document.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException('Document not found');

    if (doc.userId === userId) {
      this.logActivity(id, userId, 'VIEWED').catch(() => {});
      return doc;
    }

    // Check invite access
    const invite = await this.getInviteForUser(userId, id);
    if (!invite) throw new ForbiddenException();
    this.logActivity(id, userId, 'VIEWED').catch(() => {});
    return { ...doc, _invite: { role: invite.role } };
  }

  // ── Debug / diagnostics ───────────────────────────────────────────────────
  // Exposes raw persistence stats for one document so we can diagnose drift
  // between the REST `content` field and the Hocuspocus `yjsState` blob —
  // in particular, images that appear locally but not in prod. Owner-only.
  async getDebugInfo(userId: string, id: string) {
    const doc = await this.prisma.document.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        title: true,
        content: true,
        yjsState: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!doc) throw new NotFoundException('Document not found');
    if (doc.userId !== userId) throw new ForbiddenException();

    const contentStr = doc.content ?? '';
    const contentBytes = Buffer.byteLength(contentStr, 'utf8');
    const yjsStateBytes = doc.yjsState ? doc.yjsState.byteLength : 0;

    // Walk the TipTap JSON tree, counting image nodes and their src sizes.
    type ImageStat = { srcBytes: number; srcPrefix: string; alt: string | null };
    const images: ImageStat[] = [];
    const visit = (node: unknown) => {
      if (!node || typeof node !== 'object') return;
      const n = node as { type?: string; attrs?: { src?: string; alt?: string }; content?: unknown[] };
      if (n.type === 'image') {
        const src = n.attrs?.src ?? '';
        images.push({
          srcBytes: src.length,
          srcPrefix: src.slice(0, 48),
          alt: n.attrs?.alt ?? null,
        });
      }
      if (Array.isArray(n.content)) n.content.forEach(visit);
    };
    let parsedContent: unknown = null;
    let isValidJson = true;
    try {
      parsedContent = contentStr ? JSON.parse(contentStr) : null;
      visit(parsedContent);
    } catch {
      isValidJson = false;
    }

    const totalImageBytes = images.reduce((s, i) => s + i.srcBytes, 0);

    return {
      id: doc.id,
      title: doc.title,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      content: {
        bytes: contentBytes,
        isValidJson,
        imageCount: images.length,
        imageBytesTotal: totalImageBytes,
        images: images.slice(0, 10),
      },
      yjsState: {
        bytes: yjsStateBytes,
        present: yjsStateBytes > 0,
      },
      drift: {
        // If the REST content has images but the Yjs blob is tiny, Hocuspocus
        // will hydrate the editor with stale Yjs state on reconnect and the
        // REST fallback in DocsEditor.onSynced won't trigger (it only runs
        // when the Yjs fragment is empty).
        likelyStale: images.length > 0 && yjsStateBytes < Math.max(totalImageBytes / 4, 1024),
      },
    };
  }

  async create(userId: string, dto: CreateDocDto) {
    const parentId = dto.parentId ?? null;
    const last = await this.prisma.document.findFirst({
      where: { userId, parentId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    const nextPosition = (last?.position ?? -1) + 1;

    return this.prisma.document.create({
      data: {
        userId,
        title: dto.title ?? 'Untitled',
        emoji: dto.emoji ?? null,
        parentId,
        content: dto.content ?? null,
        tags: dto.tags ?? [],
        position: nextPosition,
      },
    });
  }

  async update(userId: string, id: string, dto: UpdateDocDto) {
    const existing = await this.verifyWriteAccess(userId, id);
    const updated = await this.prisma.document.update({
      where: { id },
      data: {
        ...(dto.title      !== undefined ? { title:      dto.title      } : {}),
        ...(dto.content    !== undefined ? { content:    dto.content    } : {}),
        ...(dto.emoji      !== undefined ? { emoji:      dto.emoji      } : {}),
        ...(dto.position   !== undefined ? { position:   dto.position   } : {}),
        ...(dto.parentId   !== undefined ? { parentId:   dto.parentId   } : {}),
        ...(dto.isFavorite !== undefined ? { isFavorite: dto.isFavorite } : {}),
        ...(dto.tags       !== undefined ? { tags:       dto.tags       } : {}),
        ...(dto.coverColor !== undefined ? { coverColor: dto.coverColor } : {}),
      },
    });
    if (dto.content !== undefined) {
      this.snapshotVersion(userId, existing).catch(() => {});
      this.logActivity(id, userId, 'EDITED').catch(() => {});
    }
    return updated;
  }

  async toggleFavorite(userId: string, id: string) {
    const doc = await this.verifyOwnership(userId, id);
    return this.prisma.document.update({
      where: { id },
      data: { isFavorite: !doc.isFavorite },
      select: { id: true, isFavorite: true },
    });
  }

  async remove(userId: string, id: string) {
    await this.verifyOwnership(userId, id);
    await this.prisma.document.delete({ where: { id } });
    return { success: true };
  }

  async duplicate(userId: string, id: string) {
    const source = await this.findOne(userId, id);
    const last = await this.prisma.document.findFirst({
      where: { userId, parentId: source.parentId ?? null },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    return this.prisma.document.create({
      data: {
        userId,
        title:      `${source.title || 'Untitled'} (copy)`,
        emoji:      source.emoji      ?? null,
        parentId:   source.parentId   ?? null,
        content:    source.content    ?? null,
        tags:       source.tags       ?? [],
        coverColor: source.coverColor ?? null,
        position:   (last?.position ?? -1) + 1,
      },
    });
  }

  // ── Share link ────────────────────────────────────────────────────────────

  async enableSharing(userId: string, id: string) {
    await this.verifyOwnership(userId, id);
    const shareToken = shortToken();
    const result = await this.prisma.document.update({
      where: { id },
      data: { shareToken, isShared: true },
      select: { shareToken: true, isShared: true },
    });
    return result;
  }

  async disableSharing(userId: string, id: string) {
    await this.verifyOwnership(userId, id);
    const result = await this.prisma.document.update({
      where: { id },
      data: { shareToken: null, isShared: false },
      select: { shareToken: true, isShared: true },
    });
    return result;
  }

  async findByShareToken(token: string) {
    const doc = await this.prisma.document.findUnique({ where: { shareToken: token } });
    if (!doc || !doc.isShared) throw new NotFoundException('Shared document not found');
    return doc;
  }

  async updateByShareToken(token: string, dto: UpdateDocDto) {
    const doc = await this.prisma.document.findUnique({ where: { shareToken: token } });
    if (!doc || !doc.isShared) throw new NotFoundException('Shared document not found');
    return this.prisma.document.update({
      where: { id: doc.id },
      data: {
        ...(dto.title   !== undefined ? { title:   dto.title   } : {}),
        ...(dto.content !== undefined ? { content: dto.content } : {}),
      },
    });
  }

  // ── Invites ───────────────────────────────────────────────────────────────

  async listInvites(userId: string, docId: string) {
    await this.verifyOwnership(userId, docId);
    return this.prisma.documentInvite.findMany({
      where: { documentId: docId },
      select: {
        id: true,
        invitedEmail: true,
        role: true,
        createdAt: true,
        inviter: { select: { displayName: true, email: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async addInvite(userId: string, docId: string, dto: CreateInviteDto) {
    const doc = await this.verifyOwnership(userId, docId);
    const inviter = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, displayName: true, zimbraHost: true, authToken: true, csrfToken: true },
    });
    if (!inviter) throw new NotFoundException('User not found');

    // Prevent inviting yourself
    if (inviter.email.toLowerCase() === dto.email.toLowerCase()) {
      throw new ConflictException('You cannot invite yourself');
    }

    const existing = await this.prisma.documentInvite.findUnique({
      where: { documentId_invitedEmail: { documentId: docId, invitedEmail: dto.email } },
    });
    if (existing) throw new ConflictException('This email is already invited');

    const invite = await this.prisma.documentInvite.create({
      data: {
        documentId: docId,
        invitedEmail: dto.email,
        invitedBy: userId,
        role: dto.role ?? InviteRole.EDITOR,
      },
      select: { id: true, invitedEmail: true, role: true, createdAt: true },
    });

    // Send notification email — best effort
    this.sendInviteEmail(inviter, dto.email, doc.title, dto.role ?? InviteRole.EDITOR).catch(
      (err) => this.logger.warn(`Failed to send invite email to ${dto.email}: ${String(err)}`),
    );

    return invite;
  }

  async updateInviteRole(userId: string, docId: string, inviteId: string, dto: UpdateInviteDto) {
    await this.verifyOwnership(userId, docId);
    const invite = await this.prisma.documentInvite.findUnique({ where: { id: inviteId } });
    if (!invite || invite.documentId !== docId) throw new NotFoundException('Invite not found');
    return this.prisma.documentInvite.update({
      where: { id: inviteId },
      data: { role: dto.role },
      select: { id: true, invitedEmail: true, role: true },
    });
  }

  async removeInvite(userId: string, docId: string, inviteId: string) {
    const invite = await this.prisma.documentInvite.findUnique({ where: { id: inviteId } });
    if (!invite || invite.documentId !== docId) throw new NotFoundException('Invite not found');

    // Allow removal by doc owner OR the invitee themselves
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    const doc = await this.prisma.document.findUnique({ where: { id: docId }, select: { userId: true } });
    const isOwner = doc?.userId === userId;
    const isSelf = user?.email?.toLowerCase() === invite.invitedEmail.toLowerCase();
    if (!isOwner && !isSelf) throw new ForbiddenException();

    await this.prisma.documentInvite.delete({ where: { id: inviteId } });
    return { success: true };
  }

  // ── Comments ──────────────────────────────────────────────────────────────

  // ── Members (for @mention autocomplete) ──────────────────────────────────

  async listMembers(userId: string, docId: string) {
    const doc = await this.verifyReadAccess(userId, docId);
    const owner = await this.prisma.user.findUnique({
      where: { id: doc.userId },
      select: { id: true, displayName: true, email: true },
    });
    const invites = await this.prisma.documentInvite.findMany({
      where: { documentId: docId },
      select: { invitedEmail: true },
    });
    // Resolve invited users who have accounts
    const invitedUsers = await this.prisma.user.findMany({
      where: { email: { in: invites.map((i) => i.invitedEmail) } },
      select: { id: true, displayName: true, email: true },
    });
    const members = [owner, ...invitedUsers].filter(Boolean);
    // Deduplicate
    const seen = new Set<string>();
    return members.filter((m) => m && !seen.has(m.id) && seen.add(m.id));
  }

  // ── Comments ──────────────────────────────────────────────────────────────

  async listComments(userId: string, docId: string) {
    await this.verifyReadAccess(userId, docId);
    const comments = await this.prisma.docComment.findMany({
      where: { documentId: docId, parentId: null },
      include: {
        author: { select: { id: true, displayName: true, email: true } },
        reactions: { select: { emoji: true, userId: true, userName: true } },
        replies: {
          include: {
            author: { select: { id: true, displayName: true, email: true } },
            reactions: { select: { emoji: true, userId: true, userName: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    return comments.map((c) => this.shapeComment(c, userId));
  }

  async createComment(userId: string, docId: string, dto: CreateCommentDto) {
    await this.verifyReadAccess(userId, docId);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { displayName: true, email: true },
    });
    const comment = await this.prisma.docComment.create({
      data: {
        documentId: docId,
        anchorId: dto.anchorId,
        content: dto.content,
        authorId: userId,
        authorName: user?.displayName ?? user?.email ?? 'Unknown',
        parentId: dto.parentId ?? null,
      },
      include: {
        author: { select: { id: true, displayName: true, email: true } },
        reactions: { select: { emoji: true, userId: true, userName: true } },
        replies: {
          include: {
            author: { select: { id: true, displayName: true, email: true } },
            reactions: { select: { emoji: true, userId: true, userName: true } },
          },
        },
      },
    });
    this.logActivity(docId, userId, 'COMMENTED', { commentId: comment.id }).catch(() => {});
    this.processMentions(docId, userId, dto.content, comment.id).catch(() => {});
    return this.shapeComment(comment, userId);
  }

  async updateComment(userId: string, docId: string, commentId: string, dto: UpdateCommentDto) {
    const comment = await this.prisma.docComment.findFirst({ where: { id: commentId, documentId: docId } });
    if (!comment) throw new NotFoundException('Comment not found');

    if (dto.content !== undefined && comment.authorId !== userId) {
      throw new ForbiddenException('Only the comment author may edit its content');
    }

    const wasResolved = !!comment.resolvedAt;
    const nowResolved = dto.resolved === true;

    const updated = await this.prisma.docComment.update({
      where: { id: commentId },
      data: {
        ...(dto.content !== undefined ? { content: dto.content } : {}),
        ...(dto.resolved !== undefined ? { resolvedAt: dto.resolved ? new Date() : null } : {}),
      },
      include: {
        author: { select: { id: true, displayName: true, email: true } },
        reactions: { select: { emoji: true, userId: true, userName: true } },
        replies: {
          include: {
            author: { select: { id: true, displayName: true, email: true } },
            reactions: { select: { emoji: true, userId: true, userName: true } },
          },
        },
      },
    });

    if (!wasResolved && nowResolved) {
      this.logActivity(docId, userId, 'RESOLVED', { commentId }).catch(() => {});
    }

    return this.shapeComment(updated, userId);
  }

  async deleteComment(userId: string, docId: string, commentId: string) {
    const comment = await this.prisma.docComment.findFirst({ where: { id: commentId, documentId: docId } });
    if (!comment) throw new NotFoundException('Comment not found');

    const doc = await this.prisma.document.findUnique({ where: { id: docId }, select: { userId: true } });
    if (comment.authorId !== userId && doc?.userId !== userId) {
      throw new ForbiddenException('Cannot delete this comment');
    }

    await this.prisma.docComment.delete({ where: { id: commentId } });
    return { success: true };
  }

  // ── Reactions ─────────────────────────────────────────────────────────────

  async toggleReaction(userId: string, docId: string, commentId: string, dto: ReactCommentDto) {
    await this.verifyReadAccess(userId, docId);
    const comment = await this.prisma.docComment.findFirst({ where: { id: commentId, documentId: docId } });
    if (!comment) throw new NotFoundException('Comment not found');

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { displayName: true, email: true },
    });
    const userName = user?.displayName ?? user?.email ?? 'Unknown';

    const existing = await this.prisma.docCommentReaction.findUnique({
      where: { commentId_userId_emoji: { commentId, userId, emoji: dto.emoji } },
    });

    if (existing) {
      await this.prisma.docCommentReaction.delete({ where: { id: existing.id } });
    } else {
      await this.prisma.docCommentReaction.create({
        data: { commentId, userId, userName, emoji: dto.emoji },
      });
    }

    const reactions = await this.prisma.docCommentReaction.findMany({
      where: { commentId },
      select: { emoji: true, userId: true, userName: true },
    });
    return this.groupReactions(reactions, userId);
  }

  // ── Version history ───────────────────────────────────────────────────────

  async listVersions(userId: string, docId: string) {
    await this.verifyReadAccess(userId, docId);
    return this.prisma.docVersion.findMany({
      where: { documentId: docId },
      select: { id: true, title: true, authorName: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async getVersion(userId: string, docId: string, versionId: string) {
    await this.verifyReadAccess(userId, docId);
    const version = await this.prisma.docVersion.findFirst({ where: { id: versionId, documentId: docId } });
    if (!version) throw new NotFoundException('Version not found');
    return version;
  }

  async restoreVersion(userId: string, docId: string, versionId: string) {
    const doc = await this.verifyWriteAccess(userId, docId);
    const version = await this.prisma.docVersion.findFirst({ where: { id: versionId, documentId: docId } });
    if (!version) throw new NotFoundException('Version not found');

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { displayName: true, email: true },
    });
    const authorName = user?.displayName ?? user?.email ?? 'Unknown';

    // Snapshot current state before overwriting
    if (doc.content) {
      await this.prisma.docVersion.create({
        data: { documentId: docId, title: doc.title, content: doc.content, authorId: userId, authorName },
      });
    }

    await this.prisma.document.update({
      where: { id: docId },
      data: { content: version.content, title: version.title, yjsState: null },
    });

    this.logActivity(docId, userId, 'EDITED', { restoredVersionId: versionId }).catch(() => {});
    return { success: true };
  }

  // ── Activity feed ─────────────────────────────────────────────────────────

  async listActivity(userId: string, docId: string) {
    await this.verifyReadAccess(userId, docId);
    return this.prisma.docActivity.findMany({
      where: { documentId: docId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, actorName: true, type: true, meta: true, createdAt: true, userId: true },
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private shapeComment(
    comment: any,
    currentUserId: string,
  ) {
    return {
      ...comment,
      reactions: this.groupReactions(comment.reactions ?? [], currentUserId),
      replies: (comment.replies ?? []).map((r: any) => ({
        ...r,
        reactions: this.groupReactions(r.reactions ?? [], currentUserId),
      })),
    };
  }

  private groupReactions(
    raw: { emoji: string; userId: string; userName: string | null }[],
    currentUserId: string,
  ) {
    const map = new Map<string, { count: number; users: string[]; selfReacted: boolean }>();
    for (const r of raw) {
      const entry = map.get(r.emoji) ?? { count: 0, users: [], selfReacted: false };
      entry.count++;
      entry.users.push(r.userName ?? r.userId);
      if (r.userId === currentUserId) entry.selfReacted = true;
      map.set(r.emoji, entry);
    }
    return Array.from(map.entries()).map(([emoji, data]) => ({ emoji, ...data }));
  }

  private async logActivity(
    documentId: string,
    userId: string | null,
    type: string,
    meta?: Record<string, unknown>,
  ) {
    const actorName = userId
      ? await this.prisma.user
          .findUnique({ where: { id: userId }, select: { displayName: true, email: true } })
          .then((u) => u?.displayName ?? u?.email ?? 'Unknown')
      : null;

    // Deduplicate VIEWED: skip if same user viewed within last 5 minutes
    if (type === 'VIEWED' && userId) {
      const recent = await this.prisma.docActivity.findFirst({
        where: {
          documentId,
          userId,
          type: 'VIEWED',
          createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },
        },
      });
      if (recent) return;
    }

    await this.prisma.docActivity.create({
      data: { documentId, userId, actorName, type, meta: meta ? (meta as Prisma.InputJsonValue) : Prisma.JsonNull },
    });
  }

  private async processMentions(
    docId: string,
    byUserId: string,
    content: string,
    commentId: string,
  ) {
    const matches = [...content.matchAll(/@([\w][\w\s]{0,30}?)(?=\s|$|[^a-zA-Z\s])/g)];
    if (!matches.length) return;

    const names = [...new Set(matches.map((m) => m[1].trim()))];
    const users = await this.prisma.user.findMany({
      where: { displayName: { in: names } },
      select: { id: true },
    });

    for (const u of users) {
      if (u.id === byUserId) continue;
      await this.logActivity(docId, u.id, 'MENTIONED', { byUserId, commentId });
    }
  }

  private async snapshotVersion(userId: string, doc: { id: string; title: string; content: string | null }) {
    if (!doc.content) return;
    const recent = await this.prisma.docVersion.findFirst({
      where: { documentId: doc.id, createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) } },
      orderBy: { createdAt: 'desc' },
    });
    if (recent) return;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { displayName: true, email: true },
    });
    await this.prisma.docVersion.create({
      data: {
        documentId: doc.id,
        title: doc.title,
        content: doc.content,
        authorId: userId,
        authorName: user?.displayName ?? user?.email ?? 'Unknown',
      },
    });

    // Prune: keep newest 50 versions only
    const old = await this.prisma.docVersion.findMany({
      where: { documentId: doc.id },
      orderBy: { createdAt: 'desc' },
      skip: 50,
      select: { id: true },
    });
    if (old.length) {
      await this.prisma.docVersion.deleteMany({ where: { id: { in: old.map((v) => v.id) } } });
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async verifyReadAccess(userId: string, id: string) {
    const doc = await this.prisma.document.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException('Document not found');
    if (doc.userId === userId) return doc;
    const invite = await this.getInviteForUser(userId, id);
    if (!invite) throw new ForbiddenException();
    return doc;
  }

  private async verifyOwnership(userId: string, id: string) {
    const doc = await this.prisma.document.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException('Document not found');
    if (doc.userId !== userId) throw new ForbiddenException();
    return doc;
  }

  private async verifyWriteAccess(userId: string, id: string) {
    const doc = await this.prisma.document.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException('Document not found');
    if (doc.userId === userId) return doc;

    // Check invite
    const invite = await this.getInviteForUser(userId, id);
    if (!invite) throw new ForbiddenException();
    if (invite.role === InviteRole.VIEWER) throw new ForbiddenException('Viewers cannot edit documents');
    return doc;
  }

  async getInviteForUser(userId: string, docId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!user) return null;
    return this.prisma.documentInvite.findUnique({
      where: { documentId_invitedEmail: { documentId: docId, invitedEmail: user.email } },
    });
  }

  private async sendInviteEmail(
    inviter: { displayName: string | null; email: string; zimbraHost: string; authToken: string | null; csrfToken: string | null },
    toEmail: string,
    docTitle: string,
    role: InviteRole,
  ) {
    if (!inviter.authToken) return;
    const inviterName = inviter.displayName ?? inviter.email;
    const roleLabel = role === InviteRole.EDITOR ? 'Editor (can edit)' : 'Viewer (read-only)';
    const appUrl = process.env.FRONTEND_URL ?? process.env.APP_URL ?? 'http://localhost:3000';
    const subject = `${inviterName} invited you to collaborate on "${docTitle}"`;
    const body = `
      <html><body style="font-family:system-ui,sans-serif;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px">
        <p>Hi,</p>
        <p><strong>${inviterName}</strong> has invited you to collaborate on the following document in 1Gov Mail:</p>
        <table style="border-collapse:collapse;width:100%;margin:16px 0">
          <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;width:120px">Document</td><td style="padding:8px;border:1px solid #e5e7eb">${docTitle}</td></tr>
          <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600">Your role</td><td style="padding:8px;border:1px solid #e5e7eb">${roleLabel}</td></tr>
        </table>
        <p>You can access it by logging in to 1Gov Mail and navigating to the <strong>Docs</strong> section — the document will appear under <em>Shared with me</em>.</p>
        <p><a href="${appUrl}/docs" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600">Open 1Gov Mail Docs</a></p>
        <p style="color:#6b7280;font-size:12px;margin-top:32px">Sent from 1Gov Mail.</p>
      </body></html>
    `;
    await this.zimbra.sendMessage(
      inviter.zimbraHost,
      inviter.authToken,
      { to: [toEmail], subject, body },
      inviter.csrfToken ?? undefined,
    );
  }
}
