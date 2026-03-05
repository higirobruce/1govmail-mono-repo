import { randomUUID } from 'crypto';
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateDocDto } from './dto/create-doc.dto';
import { UpdateDocDto } from './dto/update-doc.dto';

@Injectable()
export class DocsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(userId: string) {
    const docs = await this.prisma.document.findMany({
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
        // content deliberately excluded for list performance
      },
      orderBy: [{ position: 'asc' }, { createdAt: 'desc' }],
    });
    return docs;
  }

  async findOne(userId: string, id: string) {
    const doc = await this.prisma.document.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException('Document not found');
    if (doc.userId !== userId) throw new ForbiddenException();
    return doc;
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
    await this.verifyOwnership(userId, id);
    return this.prisma.document.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.content !== undefined ? { content: dto.content } : {}),
        ...(dto.emoji !== undefined ? { emoji: dto.emoji } : {}),
        ...(dto.position !== undefined ? { position: dto.position } : {}),
        ...(dto.parentId !== undefined ? { parentId: dto.parentId } : {}),
        ...(dto.isFavorite !== undefined ? { isFavorite: dto.isFavorite } : {}),
        ...(dto.tags !== undefined ? { tags: dto.tags } : {}),
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

  private async verifyOwnership(userId: string, id: string) {
    const doc = await this.prisma.document.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException('Document not found');
    if (doc.userId !== userId) throw new ForbiddenException();
    return doc;
  }
}
