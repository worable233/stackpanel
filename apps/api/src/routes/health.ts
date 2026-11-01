import type { FastifyInstance } from 'fastify';
import { KERNEL_API_VERSION, KERNEL_VERSION } from '@stackpanel/spec';
import { healthResponseSchema } from '../lib/openapi.ts';
import { getInfraConfig, getStorage } from '../infra.ts';
import { pingRedis } from '@stackpanel/db';
import { frontendReadiness } from '../lib/frontend-readiness.ts';
import { fallbackBootReport, getBootReport } from '../lib/boot-report.ts';
import { memoryPressure, memoryReport } from '../lib/memory-report.ts';
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

  /**
   * 构建身份 + 启动自检（版本、提交号、信任根、反代信任配置）。
   *
   * 排障第一个问题永远是「这个容器跑的是哪一次构建」。以前只能靠行为观察
   * （比如「首页有没有样式」），现在一次 GET 就有答案，而且能看出信任根是否齐、
   * 真实客户端 IP 是否会被正确处理。
   */
  app.get('/version', async () => getBootReport() ?? fallbackBootReport(KERNEL_VERSION));

  app.get('/ready', async (_request, reply) => {
    const checks: Record<string, 'ok' | 'unreachable' | 'disabled'> = {};
    // 内存放进 readiness 响应（v0.1.1 的 OOM 盲区）：运维在容器被反复重启、连
    // `docker exec` 都进不去时，仍能从外部轮询看到堆占用与上限的趋势。
    // `memoryPressure` 不参与 503 判定：高水位不等于不可用，把正在服务的副本摘掉
    // 只会把压力推给剩下的实例。
    const memory = memoryReport();

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
    if ('ping' in driver && typeof (driver as { ping?: unknown }).ping === 'function') {
      storageOk = await (driver as unknown as { ping(): Promise<boolean> }).ping();
      checks['storage'] = storageOk ? 'ok' : 'unreachable';
    } else {
      checks['storage'] = 'ok';
    }

    // Contract 04 §4.2: activation is only safe once every served revision has
    // finished materializing on this replica (`.ready`). Surface it as a first
    // class readiness dependency so an orchestrator stops routing traffic to a
    // replica that is still localizing a revision.
    let frontendOk: boolean;
    let frontend: Awaited<ReturnType<typeof frontendReadiness>> | null = null;
    try {
      frontend = await frontendReadiness();
      frontendOk = frontend.ok;
      checks['frontend'] = frontend.ok ? 'ok' : 'unreachable';
    } catch {
      checks['frontend'] = 'unreachable';
      frontendOk = false;
    }
    if (databaseOk && redisOk && storageOk && frontendOk) {
      return {
        status: 'ready',
        ...checks,
        memory,
        ...(memoryPressure(memory) ? { memoryPressure: true } : {}),
      };
    }
    return reply.code(503).send({
      status: 'degraded',
      ...checks,
      memory,
      ...(memoryPressure(memory) ? { memoryPressure: true } : {}),
      ...(frontend && !frontend.ok ? { pendingFrontends: frontend.pending } : {}),
    });
  });

  /**
   * Detailed frontend readiness for a specific replica (contract 04 §4.2).
   * The aggregate `/ready` above is what orchestrators should poll; this
   * endpoint exists so an operator can see exactly which revision is pending.
   */
  app.get('/ready/frontend', async (_request, reply) => {
    const readiness = await frontendReadiness();
    const body = {
      status: readiness.ok ? 'ready' : 'degraded',
      pending: readiness.pending,
      frontends: readiness.entries,
    };
    return readiness.ok ? body : reply.code(503).send(body);
  });
}
