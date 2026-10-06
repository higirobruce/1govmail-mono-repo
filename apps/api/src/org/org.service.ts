import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  type DigestWindow, type OrgDigest, WINDOW_DAYS,
} from './org.types';
import { selectMeetings } from './org.meetings';
import { selectDocumentsAndMinutes } from './org.documents';
import { OrgNarrativeService } from './org.narrative';

const DAY_MS = 86_400_000;

@Injectable()
export class OrgService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly narrative: OrgNarrativeService,
  ) {}

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

    const range = this.windowRange(window);
    const [meetings, docs] = await Promise.all([
      selectMeetings(this.prisma, institutionId, range),
      selectDocumentsAndMinutes(this.prisma, institutionId, range),
    ]);

    // Meetings lead. Deliberate editorial ordering — do not sort these together.
    const ahead = meetings.ahead;
    const concluded = [...meetings.concluded, ...docs.concluded];

    const narrative = await this.narrative.get(institutionId, window, [...ahead, ...concluded]);
    return { window, institutionId, narrative, ahead, concluded };
  }
}
