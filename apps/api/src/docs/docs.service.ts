import { randomUUID } from 'crypto';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InviteRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ZimbraService } from '../zimbra/zimbra.service';
import { CreateDocDto } from './dto/create-doc.dto';
import { UpdateDocDto } from './dto/update-doc.dto';
import { CreateInviteDto } from './dto/create-invite.dto';
import { UpdateInviteDto } from './dto/update-invite.dto';

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
    if (doc.userId === userId) return doc;

    // Check invite access
    const invite = await this.getInviteForUser(userId, id);
    if (!invite) throw new ForbiddenException();
    return { ...doc, _invite: { role: invite.role } };
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
    await this.verifyWriteAccess(userId, id);
    return this.prisma.document.update({
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

  // ── Share link ────────────────────────────────────────────────────────────

  async enableSharing(userId: string, id: string) {
    await this.verifyOwnership(userId, id);
    const shareToken = randomUUID();
    return this.prisma.document.update({
      where: { id },
      data: { shareToken, isShared: true },
      select: { shareToken: true, isShared: true },
    });
  }

  async disableSharing(userId: string, id: string) {
    await this.verifyOwnership(userId, id);
    return this.prisma.document.update({
      where: { id },
      data: { shareToken: null, isShared: false },
      select: { shareToken: true, isShared: true },
    });
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

  // ── Helpers ───────────────────────────────────────────────────────────────

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
    const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
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
