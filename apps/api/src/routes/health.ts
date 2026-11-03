import type { FastifyInstance } from 'fastify';
import { KERNEL_API_VERSION, KERNEL_VERSION } from '@stackpanel/spec';
import { healthResponseSchema } from '../lib/openapi.ts';
import { getInfraConfig, getStorage } from '../infra.ts';
import { pingRedis } from '@stackpanel/db';
import { frontendReadiness } from '../lib/frontend-readiness.ts';
import { fallbackBootReport, getBootReport } from '../lib/boot-report.ts';
import { memoryPressure, memoryReport } from '../lib/memory-report.ts';
import { getPrisma } from '../plugins/prisma.ts';
import { readProxyHealth } from '../lib/proxy-check.ts';
import { resolveLlmProvider } from '../lib/llm-provider.ts';

/** `/ready` 里那段只读的 Agent 自检结果（C-3）。 */
export interface AgentHealth {
  /** 管理员开关（`Setting['agent.enabled']`）。 */
  enabled: boolean;
  /**
   * 是否真的**能调到模型**。
   *
   * 必须与 `resolveLlmProvider()` 同口径：那个函数才是所有 Agent 请求的实际
   * 闸门。以前这里只看 `Setting['agent.llm']` 里有没有 `baseUrl`/`model` 两个
   * 字符串，于是两种状态都会报错：
   *
   * - **假绿**：管理员填了地址和模型、但保存密钥失败（或密钥被删），
   *   `Setting` 仍然完整，`/ready` 说已配置，而每一次运行都在建 run 之前就抛
   *   `agent.llm_unconfigured`。运维看着「一切正常」的探针去查权限和网络。
   * - **假红**：插件通过 `llmProvider` 扩展点提供模型时根本没有 `agent.llm`
   *   这个设置，`/ready` 说未配置，实际完全可用。
   *
   * 现在直接问 `resolveLlmProvider()`：它按「插件扩展点 → 兜底配置（含密钥解密）」
   * 的顺序解析，返回 `null` 才代表真的调不到模型。
   */
  llmConfigured: boolean;
  /** 提供模型的来源：`plugin` / `configured`；未配置时为 `null`。 */
  llmProvider: string | null;
  /** 最近一次运行的时间；`null` = 从未跑过，这正是要暴露的信号。 */
  lastRunAt: string | null;
  lastRunStatus: string | null;
  runCount: number;
  /** 运行里出现过的最后一个错误（便于一眼看出「配了但没通」）。 */
  lastError: string | null;
}

/**
 * 汇总 Agent 的实际可用状态。
 *
 * 只读：不改开关、不调模型、不写审计。放在 `/ready` 里是因为运维第一眼看的就是
 * 它；「enabled=true 但 runCount=0」这种状态必须在这里显形，而不是要人翻数据库。
 */
export async function readAgentHealth(
  runtime?: Parameters<typeof resolveLlmProvider>[0],
): Promise<AgentHealth> {
  const prisma = getPrisma();
  const [enabledRow, lastRun, runCount] = await Promise.all([
    prisma.setting.findUnique({ where: { key: 'agent.enabled' } }),
    prisma.agentRun.findFirst({ orderBy: { createdAt: 'desc' } }),
    prisma.agentRun.count(),
  ]);
  const enabledValue: unknown = enabledRow?.value;
  const enabled =
    enabledValue === true ||
    (enabledValue !== null &&
      typeof enabledValue === 'object' &&
      (enabledValue as Record<string, unknown>)['enabled'] === true);
  // 解析失败（例如密钥密文损坏）不能把探针整个打挂：那会让 `/ready` 变成 500，
  // 而真正要传达的是「Agent 不可用」。按未配置处理并把原因留在 lastError 之外
  // —— 密钥损坏在管理员保存/测试连接时已经有明确错误码。
  let provider: Awaited<ReturnType<typeof resolveLlmProvider>> = null;
  if (runtime) {
    try {
      provider = await resolveLlmProvider(runtime);
    } catch {
      provider = null;
    }
  }
  return {
    enabled,
    llmConfigured: provider !== null,
    llmProvider: provider?.id ?? null,
    lastRunAt: lastRun ? lastRun.createdAt.toISOString() : null,
    lastRunStatus: lastRun?.status ?? null,
    runCount,
    lastError: lastRun?.error ?? null,
  };
}

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

  app.get('/ready', async (request, reply) => {
    const checks: Record<string, 'ok' | 'unreachable' | 'disabled'> = {};
    // 内存放进 readiness 响应（v0.1.1 的 OOM 盲区）：运维在容器被反复重启、连
    // `docker exec` 都进不去时，仍能从外部轮询看到堆占用与上限的趋势。
    // `memoryPressure` 不参与 503 判定：高水位不等于不可用，把正在服务的副本摘掉
    // 只会把压力推给剩下的实例。
    const memory = memoryReport();
    // 反代自检的精简版：面板健康检查、编排探针、同机 curl 都能看到，不需要管理员
    // 登录。`trusted=false` 且报了 X-Forwarded-For 就是「全员共用一个 IP」的现场。
    // 与 `/error`/`memory` 一样**不参与** 503 判定：配置不对仍然能服务。
    const proxy = readProxyHealth(request);

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
    // C-3：「Agent 开了但从未跑过」必须可观测。一个建站至今 0 条 run 的实例
    // 在旧版 `/ready` 里是彻底隐形的——开关是 true、模型也配了，可谁也没发现
    // 它一次都没成功执行过。这里只读、不扣费，也不改变就绪判定。
    let agent: AgentHealth | null = null;
    if (databaseOk) {
      try {
        // 传 runtime：`llmConfigured` 必须与 `resolveLlmProvider()` 同口径，
        // 否则插件提供的模型会被误报为「未配置」。
        agent = await readAgentHealth(app.pluginRuntime);
      } catch {
        agent = null;
      }
    }
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
        proxy,
        ...(memoryPressure(memory) ? { memoryPressure: true } : {}),
        ...(agent ? { agent } : {}),
      };
    }
    return reply.code(503).send({
      status: 'degraded',
      ...checks,
      memory,
      proxy,
      ...(memoryPressure(memory) ? { memoryPressure: true } : {}),
      ...(frontend && !frontend.ok ? { pendingFrontends: frontend.pending } : {}),
      ...(agent ? { agent } : {}),
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
