import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

const RETENTION_DAYS = Number(process.env.AI_HISTORY_RETENTION_DAYS ?? 90);
const EVICT_BATCH_PER_TICK = Number(process.env.AI_HISTORY_EVICT_BATCH ?? 500);

/**
 * Ages out saved conversations, and the agent tool logs written inside them.
 *
 * Two things carry this job. It measures from `lastTurnAt`, not `createdAt` —
 * otherwise a conversation somebody is still using disappears on its ninetieth
 * day. And it deletes in capped batches rather than one statement: the first run
 * against a populated table would otherwise hold a long transaction on a pooled
 * connection, which is the failure the notifications work hit.
 */
@Injectable()
export class HistoryEvictWorker {
  private readonly logger = new Logger(HistoryEvictWorker.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM, { waitForCompletion: true })
  async tick(): Promise<void> {
    try {
      const { conversations, toolLogs } = await this.processTick();
      this.logger.log(`ai history eviction: -${conversations} conversations -${toolLogs} tool logs`);
    } catch (err: any) {
      this.logger.error(`ai history eviction failed: ${err?.message}`);
    }
  }

  async processTick(): Promise<{ conversations: number; toolLogs: number }> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000);

    // Select ids first, then delete that exact set. A bare deleteMany on the
    // predicate cannot be capped, so a backlog would go out in one statement.
    const stale = await this.prisma.aiConversation.findMany({
      where: { lastTurnAt: { lt: cutoff } },
      select: { id: true },
      take: EVICT_BATCH_PER_TICK,
    });

    let conversations = 0;
    if (stale.length) {
      const { count } = await this.prisma.aiConversation.deleteMany({
        where: { id: { in: stale.map((c) => c.id) } },
      });
      conversations = count;
    }

    // The backstop for logs with no conversation: rows written before the link
    // existed, and turns that never produced a completed answer so never made
    // a conversation to hang off.
    const { count: toolLogs } = await this.prisma.agentToolLog.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });

    return { conversations, toolLogs };
  }
}
