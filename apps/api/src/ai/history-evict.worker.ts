import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

const settingsLogger = new Logger('HistoryEvictWorker');

/**
 * Read a positive-integer setting, falling back LOUDLY on anything that is
 * not one.
 *
 * `Number(process.env.X ?? 90)` was the shape here, and `??` only catches
 * undefined: a `.env` line of `AI_HISTORY_RETENTION_DAYS=` (or a blank value
 * in a systemd unit) yields `Number('') === 0`, which puts the horizon at
 * *now* — the next tick then deletes every user's entire history and reports
 * a healthy-looking eviction in the journal. A non-numeric value yields NaN,
 * an Invalid Date, and a caught error every night. Both fail silently in
 * exactly the way an operator would not notice.
 *
 * An UNSET variable is normal and passes quietly; a set-but-unusable one is
 * a misconfiguration and says so.
 */
export function positiveSetting(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) {
    settingsLogger.warn(
      `${name}="${raw}" is not a positive number — falling back to ${fallback}`,
    );
    return fallback;
  }
  return Math.floor(n);
}

export const RETENTION_DAYS = positiveSetting(
  'AI_HISTORY_RETENTION_DAYS', process.env.AI_HISTORY_RETENTION_DAYS, 90,
);
/** Rows per DELETE — bounds one statement, not one night's work. */
export const EVICT_BATCH = positiveSetting(
  'AI_HISTORY_EVICT_BATCH', process.env.AI_HISTORY_EVICT_BATCH, 500,
);
/** Hard stop on a single tick, so it cannot run unbounded against a huge backlog. */
export const EVICT_MAX_BATCHES_PER_TICK = positiveSetting(
  'AI_HISTORY_EVICT_MAX_BATCHES', process.env.AI_HISTORY_EVICT_MAX_BATCHES, 100,
);

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
 * `EVICT_BATCH` bounds one STATEMENT, not one tick. The tick keeps taking
 * batches until one comes back short, because the cron runs daily: at 500
 * rows a day against this feature's own projected creation rate of thousands
 * a day, the deficit is permanent and both tables grow monotonically — the
 * exact outcome this worker exists to prevent, on a box already at 78% disk.
 * `EVICT_MAX_BATCHES_PER_TICK` is the ceiling that keeps a tick bounded, and
 * hitting it is WARNed rather than logged, because a sweep that silently
 * never catches up otherwise reads identically to one that is keeping up.
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
      const { conversations, toolLogs, capped } = await this.processTick();
      const counts = `-${conversations} conversations -${toolLogs} tool logs`;
      if (capped) {
        this.logger.warn(
          `ai history eviction: ${counts} — per-tick ceiling of ` +
          `${EVICT_MAX_BATCHES_PER_TICK}x${EVICT_BATCH} reached, rows still remain past the horizon`,
        );
      } else {
        this.logger.log(`ai history eviction: ${counts} (nothing left past the horizon)`);
      }
    } catch (err: any) {
      this.logger.error(`ai history eviction failed: ${err?.message}`);
    }
  }

  async processTick(): Promise<{ conversations: number; toolLogs: number; capped: boolean }> {
    // One horizon for the whole tick: recomputing it per batch would let a
    // row age into a later batch mid-sweep, which makes the run irreproducible.
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000);

    // Select ids first, then delete that exact set, re-asserting the same
    // predicate on the delete. Without the re-assert, a conversation that
    // gets a fresh turn between the select and the delete — moving its
    // lastTurnAt back inside the horizon — would still be deleted.
    const conversations = await this.drain(
      () => this.prisma.aiConversation.findMany({
        where: { lastTurnAt: { lt: cutoff } },
        select: { id: true },
        take: EVICT_BATCH,
      }),
      (ids) => this.prisma.aiConversation.deleteMany({
        where: { id: { in: ids }, lastTurnAt: { lt: cutoff } },
      }),
    );

    // Orphaned tool logs only — see class comment for why this excludes rows
    // still linked to a conversation inside the horizon. Batched and looped
    // the same way, and for the same reason: this table is the one most
    // likely to have a large backlog on the first run.
    const toolLogs = await this.drain(
      () => this.prisma.agentToolLog.findMany({
        where: { conversationId: null, createdAt: { lt: cutoff } },
        select: { id: true },
        take: EVICT_BATCH,
      }),
      (ids) => this.prisma.agentToolLog.deleteMany({
        where: { id: { in: ids }, conversationId: null },
      }),
    );

    return {
      conversations: conversations.deleted,
      toolLogs: toolLogs.deleted,
      capped: conversations.capped || toolLogs.capped,
    };
  }

  /**
   * Take batch after batch until one comes back short of the cap — that is
   * the only reliable "nothing left" signal, since the delete's re-asserted
   * predicate means `count` can legitimately be lower than what was selected.
   */
  private async drain(
    select: () => Promise<Array<{ id: string }>>,
    remove: (ids: string[]) => Promise<{ count: number }>,
  ): Promise<{ deleted: number; capped: boolean }> {
    let deleted = 0;
    for (let batch = 0; batch < EVICT_MAX_BATCHES_PER_TICK; batch++) {
      const rows = await select();
      if (!rows.length) return { deleted, capped: false };
      const { count } = await remove(rows.map((r) => r.id));
      deleted += count;
      // No progress: the delete re-asserts the select's own predicate, so a
      // batch that removes nothing would be re-selected identically next
      // time round. Stop rather than spend the whole ceiling on it.
      if (!count) return { deleted, capped: false };
      if (rows.length < EVICT_BATCH) return { deleted, capped: false };
    }
    return { deleted, capped: true };
  }
}
