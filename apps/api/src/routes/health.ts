import type { FastifyInstance } from 'fastify';
import { KERNEL_API_VERSION, KERNEL_VERSION } from '@stackpanel/spec';
import { healthResponseSchema } from '../lib/openapi.ts';
import { getInfraConfig, getStorage } from '../infra.ts';
import { pingRedis } from '@stackpanel/db';
import { getPrisma } from '../plugins/prisma.ts';

/**
 * Liveness + readiness probes.
 * `/ready` performs real round-trips against every required dependency and
 * degrades to 503 when any is unavailable, so a load balancer stops routing.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', { schema: { response: { 200: healthResponseSchema } } }, async () => ({
    status: 'ok',
    version: KERNEL_VERSION,
    apiVersion: KERNEL_API_VERSION,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  }));

  app.get('/ready', async (_request, reply) => {
    const checks: Record<string, 'ok' | 'unreachable' | 'disabled'> = {};

    let databaseOk = false;
    try {
      const prisma = getPrisma();
      await prisma.$queryRaw`SELECT 1`;
      databaseOk = true;
      checks['database'] = 'ok';
    } catch {
      checks['database'] = 'unreachable';
    }

    let redisOk = true;
    if (getInfraConfig().redisUrl) {
      redisOk = await pingRedis();
      checks['redis'] = redisOk ? 'ok' : 'unreachable';
    } else {
      checks['redis'] = 'disabled';
    }

    let storageOk = true;
    const driver = getStorage();
    if (driver.kind === 's3' && 'ping' in driver) {
      storageOk = await (driver as unknown as { ping(): Promise<boolean> }).ping();
      checks['storage'] = storageOk ? 'ok' : 'unreachable';
    } else {
      checks['storage'] = 'ok';
    }

    if (databaseOk && redisOk && storageOk) {
      return { status: 'ready', ...checks };
    }
    return reply.code(503).send({ status: 'degraded', ...checks });
  });
}
