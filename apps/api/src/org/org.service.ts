import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  type DigestWindow, type OrgDigest, type OrgItem, WINDOW_DAYS,
} from './org.types';

const DAY_MS = 86_400_000;

@Injectable()
export class OrgService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The caller's institution, read from their own row. Never a parameter:
   * a user must not be able to ask for another institution's digest.
   */
  async resolveInstitution(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { institutionId: true },
    });
    return user?.institutionId ?? null;
  }

  windowRange(window: DigestWindow) {
    const days = WINDOW_DAYS[window];
    const now = new Date();
    return {
      aheadFrom: now,
      aheadTo: new Date(now.getTime() + days * DAY_MS),
      pastFrom: new Date(now.getTime() - days * DAY_MS),
      pastTo: now,
    };
  }

  async getDigest(userId: string, window: DigestWindow): Promise<OrgDigest> {
    const institutionId = await this.resolveInstitution(userId);
    // Fail closed. No institution means no org to report on — never "everything".
    if (!institutionId) {
      return { window, institutionId: null, narrative: null, ahead: [], concluded: [] };
    }

    const ahead: OrgItem[] = [];
    const concluded: OrgItem[] = [];
    return { window, institutionId, narrative: null, ahead, concluded };
  }
}
