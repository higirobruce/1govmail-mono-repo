import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

const RETENTION_DAYS = Number(process.env.AI_HISTORY_RETENTION_DAYS ?? 90);
const EVICT_BATCH_PER_TICK = Number(process.env.AI_HISTORY_EVICT_BATCH ?? 500);

/**
 * Ages out saved conversations, and the agent tool logs orphaned by that
 * eviction (or written before a conversation ever linked to them).
 *
 * Two things carry this job. It measures from `lastTurnAt`, not `createdAt` —
 * otherwise a conversation somebody is still using disappears on its ninetieth
 * day. And every delete goes out in capped batches, id-list first: a bare
 * `deleteMany` on a predicate cannot be capped, so the first run against a
 * populated table would hold a long transaction on a pooled connection, which
 * is the failure the notifications work hit. Both `agent_tool_logs` and
 * `ai_conversations` get this treatment — `agent_tool_logs` has accumulated
 * unbounded since the phase-4 agent work, so it is the table where an
 * unbatched sweep would hurt most.
 *
 * The tool-log sweep is orphan-only (`conversationId: null`): a linked
 * conversation's own 90-day inactivity expiry is what bounds its tool logs,
 * via cascade delete when the conversation itself ages out. Sweeping linked
 * logs by age here as well was considered and rejected — a conversation
 * someone keeps using has a fresh `lastTurnAt` and correctly survives, but an
 * unscoped age sweep would still delete its early turns' tool logs, erasing
 * the record of a confirm-gated send inside a conversation that is still
 * readable.
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

    // Select ids first, then delete that exact set, re-asserting the same
    // predicate on the delete. Without the re-assert, a conversation that
    // gets a fresh turn between the select and the delete — moving its
    // lastTurnAt back inside the horizon — would still be deleted.
    const staleConversations = await this.prisma.aiConversation.findMany({
      where: { lastTurnAt: { lt: cutoff } },
      select: { id: true },
      take: EVICT_BATCH_PER_TICK,
    });

    let conversations = 0;
    if (staleConversations.length) {
      const ids = staleConversations.map((c) => c.id);
      const { count } = await this.prisma.aiConversation.deleteMany({
        where: { id: { in: ids }, lastTurnAt: { lt: cutoff } },
      });
      conversations = count;
    }

    // Orphaned tool logs only — see class comment for why this excludes rows
    // still linked to a conversation inside the horizon. Batched the same way
    // as the conversation sweep, and for the same reason: this table is the
    // one most likely to have a large backlog on the first run.
    const staleToolLogs = await this.prisma.agentToolLog.findMany({
      where: { conversationId: null, createdAt: { lt: cutoff } },
      select: { id: true },
      take: EVICT_BATCH_PER_TICK,
    });

    let toolLogs = 0;
    if (staleToolLogs.length) {
      const ids = staleToolLogs.map((l) => l.id);
      const { count } = await this.prisma.agentToolLog.deleteMany({
        where: { id: { in: ids }, conversationId: null },
      });
      toolLogs = count;
    }

    return { conversations, toolLogs };
  }
}
