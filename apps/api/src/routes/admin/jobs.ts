import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireRole } from '../../plugins/auth.ts';
import { getInfraConfig } from '../../infra.ts';
import { listDeadLetterJobs, retryDeadLetterJob } from '../../jobs/index.ts';

const adminOnly = [requireAuth, requireRole('ADMIN')];

/**
 * Background-job observability (S6 / ADR-0013 §5). Exposes the dead-letter set
 * — jobs that exhausted their retry budget — and lets an admin replay one.
 * Read-only listing plus an explicit replay action; no arbitrary inspection.
 */
export async function adminJobsRoutes(app: FastifyInstance): Promise<void> {
  const redisUrl = () => getInfraConfig().redisUrl ?? null;

  app.get('/admin/jobs/dead-letter', { preHandler: adminOnly }, async () => {
    const jobs = await listDeadLetterJobs(redisUrl());
    return { jobs, available: redisUrl() !== null };
  });

  app.post('/admin/jobs/dead-letter/:id/retry', { preHandler: adminOnly }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: '请求参数无效' });
    const jobId = await retryDeadLetterJob(redisUrl(), params.data.id);
    if (!jobId) return reply.code(404).send({ error: '死信任务不存在或不可重放' });
    return { retried: true, jobId };
  });
}
