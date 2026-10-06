import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AiService } from '../ai/ai.service';
import { consumeAgentJson } from '../agent/upstream-stream';
import { NARRATIVE_MIN_ITEMS, type DigestWindow, type OrgItem } from './org.types';

const MODEL_TIMEOUT_MS = 20_000;

/** Stable across ordering so a reshuffle does not force a regeneration. */
export function contentHashOf(items: OrgItem[]): string {
  const ids = items.map((i) => `${i.kind}:${i.id}`).sort().join(',');
  return createHash('sha256').update(ids).digest('hex');
}

@Injectable()
export class OrgNarrativeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
  ) {}

  /**
   * Two or three sentences over the items already selected for the lists.
   *
   * Cached per (institution, window) so everyone in the institution reads the
   * same sentences for one generation per period, rather than one per login.
   * Returns null — never throws — when below the floor or when the model is
   * unavailable: the digest must not fail because generation did.
   */
  async get(
    institutionId: string,
    window: DigestWindow,
    items: OrgItem[],
  ): Promise<string | null> {
    if (items.length < NARRATIVE_MIN_ITEMS) return null;

    const hash = contentHashOf(items);
    const cached = await this.prisma.orgDigestNarrative.findUnique({
      where: { institutionId_window: { institutionId, window } },
    });
    if (cached && cached.contentHash === hash) return cached.content;

    let text: string;
    try {
      text = await this.generate(items, window);
    } catch {
      return null;
    }
    if (!text.trim()) return null;

    await this.prisma.orgDigestNarrative.upsert({
      where: { institutionId_window: { institutionId, window } },
      create: { institutionId, window, contentHash: hash, content: text, model: 'default' },
      update: { contentHash: hash, content: text, model: 'default', generatedAt: new Date() },
    });
    return text;
  }

  /**
   * The model sees ONLY what is already on the page: kind, title, date and
   * participant count. No message, no document body, no link — every claim it
   * can make is traceable to a row rendered directly beneath it.
   */
  private async generate(items: OrgItem[], window: DigestWindow): Promise<string> {
    const lines = items
      .map((i) => `- [${i.kind}] ${i.title} (${i.at.slice(0, 10)}, ${i.participantCount} people)`)
      .join('\n');
    const body = {
      messages: [
        {
          role: 'system',
          content:
            'You summarise an organisation\'s activity for colleagues. Write two or three ' +
            'plain sentences about what the organisation is collectively working on. Use ONLY ' +
            'the items given. Never invent a project, person, or deadline. No bullet points, ' +
            'no preamble, no heading.',
        },
        { role: 'user', content: `Activity for this ${window}:\n${lines}` },
      ],
      max_tokens: 220,
      temperature: 0.2,
    } as any;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), MODEL_TIMEOUT_MS);
    try {
      const upstream = await this.ai.upstream(body, ac.signal);
      const result = await consumeAgentJson(upstream, () => {});
      return result.text.trim();
    } finally {
      clearTimeout(timer);
    }
  }
}
