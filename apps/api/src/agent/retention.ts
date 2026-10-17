import type { PrismaClient } from '@stackpanel/db';
import type { JobContext } from '@stackpanel/sdk';
import { z } from 'zod';
import { getPrisma } from '../plugins/prisma.ts';

export const RETENTION_KEY = 'agent.conversationRetention';
export const CLEANUP_KEY = 'agent.conversationCleanup';
export const retentionSchema = z
  .object({
    retentionDays: z.number().int().min(1).max(3650).nullable(),
    maxConversationsPerUser: z.number().int().min(1).max(10000).nullable(),
  })
  .strict();
export type RetentionPolicy = z.infer<typeof retentionSchema>;
export const DEFAULT_RETENTION: RetentionPolicy = {
  retentionDays: null,
  maxConversationsPerUser: null,
};
const BATCH_SIZE = 500;

export async function readRetention(db: PrismaClient) {
  const row = await db.setting.findUnique({ where: { key: RETENTION_KEY } });
  const parsed = retentionSchema.safeParse(row?.value);
  // Missing or malformed settings never authorize deletion.
  return parsed.success ? parsed.data : { ...DEFAULT_RETENTION };
}

export async function retentionView(db: PrismaClient) {
  const [policy, conversations, messages, last] = await Promise.all([
    readRetention(db),
    db.agentConversation.count(),
    db.agentChatMessage.count(),
    db.setting.findUnique({ where: { key: CLEANUP_KEY } }),
  ]);
  return { policy, stats: { conversations, messages }, lastCleanup: last?.value ?? null };
}

/** Bounded, repeatable cleanup. Serialize policy changes and cleanup across replicas.
 * Row locks coordinate with message appends; SKIP LOCKED protects active writers.
 * Attachment records/files belong to media, and are never deleted by chat retention.
 */
export async function cleanupConversations(db: PrismaClient, now = new Date()) {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${RETENTION_KEY}))`;
      const setting = await tx.setting.findUnique({ where: { key: RETENTION_KEY } });
      const parsed = retentionSchema.safeParse(setting?.value);
      const policy = parsed.success ? parsed.data : DEFAULT_RETENTION;
      const cutoff =
        policy.retentionDays === null
          ? null
          : new Date(now.getTime() - policy.retentionDays * 86400_000);
      const cap = policy.maxConversationsPerUser;
      let deleted = 0;
      if (cutoff !== null || cap !== null) {
        const rows = await tx.$queryRaw<{ id: string }[]>`
        WITH ranked AS (
          SELECT "id", "updatedAt", row_number() OVER (
            PARTITION BY "userId" ORDER BY "updatedAt" DESC, "id" DESC
          ) AS position FROM "agent_conversations"
        ), candidates AS (
          SELECT c."id" FROM "agent_conversations" c JOIN ranked r ON c."id" = r."id"
          WHERE c."updatedAt" = r."updatedAt" AND (
            (${cutoff}::timestamp IS NOT NULL AND c."updatedAt" < ${cutoff}::timestamp)
            OR (${cap}::integer IS NOT NULL AND r.position > ${cap}::integer)
          )
          ORDER BY c."updatedAt", c."id" LIMIT ${BATCH_SIZE} FOR UPDATE OF c SKIP LOCKED
        )
        DELETE FROM "agent_conversations" WHERE "id" IN (SELECT "id" FROM candidates) RETURNING "id"
      `;
        deleted = rows.length;
      }
      const result = {
        completedAt: now.toISOString(),
        deleted,
        batchLimit: BATCH_SIZE,
        mayHaveMore: deleted === BATCH_SIZE,
      };
      await tx.setting.upsert({
        where: { key: CLEANUP_KEY },
        create: { key: CLEANUP_KEY, value: result },
        update: { value: result },
      });
      return result;
    },
    { timeout: 30_000 },
  );
}

export function registerConversationRetentionJobs(jobs: JobContext) {
  jobs.handle('agent.conversation-cleanup', async () => {
    await cleanupConversations(getPrisma());
  });
  void jobs.schedule('agent.conversation-cleanup', { everyMs: 60 * 60_000 });
}
