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
        position: true,
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
    const last = await this.prisma.document.findFirst({
      where: { userId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    const nextPosition = (last?.position ?? -1) + 1;

    return this.prisma.document.create({
      data: {
        userId,
        title: dto.title ?? 'Untitled',
        emoji: dto.emoji ?? null,
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
      },
    });
  }

  async remove(userId: string, id: string) {
    await this.verifyOwnership(userId, id);
    await this.prisma.document.delete({ where: { id } });
    return { success: true };
  }

  private async verifyOwnership(userId: string, id: string) {
    const doc = await this.prisma.document.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException('Document not found');
    if (doc.userId !== userId) throw new ForbiddenException();
    return doc;
  }
}
