import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  buildUpdatePlan,
  listTaskResults,
  loadKernelCandidates,
  readCatalogSnapshot,
  readTaskResult,
  readUpdaterStatus,
  readUpdatePolicy,
  requiresAuthorization,
  saveUpdatePolicy,
  submitUpdateTask,
  updateCatalogContext,
  updateChannelRoot,
  updateInstanceId,
  readSelfUpdateRequest,
  submitSelfUpdateRequest,
  clearSelfUpdateRequest,
  SelfUpdateRequestError,
  type PlanOutcome,
  type UpdatePolicy,
} from '../../updates/index.ts';
import { getCatalogRefresh } from '../../distribution/runtime.ts';
import { auditContext, writeAudit } from '../../plugins/audit.ts';
import { getPrisma } from '../../plugins/prisma.ts';
import { env } from '../../config/env.ts';
import { requireAuth, requireRole } from '../../plugins/auth.ts';
import { notifyUserBestEffort } from '../../notifications/notify.ts';

const adminOnly = [requireAuth, requireRole('ADMIN')];

const policySchema = z.object({
  autoUpdate: z.boolean().optional(),
  channel: z.enum(['stable', 'beta']).optional(),
  autoUpdateKernel: z.boolean().optional(),
  excluded: z.array(z.string().min(1).max(128)).max(500).optional(),
  pinned: z.record(z.string().min(1).max(128), z.string().min(1).max(64)).optional(),
  /**
   * 维护窗口。显式传 `null` 表示清除限制（表单里把「只在窗口内」取消勾选就是这种情形）；
   * 不传则保留当前值。没有 `null` 时，一旦设过窗口就再也关不掉。
   */
  maintenanceWindow: z
    .object({
      startHour: z.number().int().min(0).max(23),
      endHour: z.number().int().min(0).max(23),
    })
    .nullable()
    .optional(),
  allowPermissionIncrease: z.boolean().optional(),
  allowIrreversibleMigration: z.boolean().optional(),
});

const installSchema = z.object({
  /** 显式确认包含需人工授权的变更（权限增加 / 不可逆迁移）。 */
  acknowledge: z.boolean().default(false),
  /**
   * 显式确认「目录快照已过期仍要投递」。
   *
   * 过期目录仍可展示与求解（便于人工决策），但 PLAN §3.3 / ADR-0023 决策 2 要求
   * 「过期目录禁止发起新自动安装」——所以默认拒绝，只有管理员显式勾选才放行一次。
   */
  allowExpired: z.boolean().default(false),
  /** 可选固定幂等键。 */
  idempotencyKey: z.string().min(1).max(128).optional(),
});

const selfUpdateSchema = z.object({
  /**
   * 候选 updater 镜像摘要。接受裸 sha256 hex 或 `repo@sha256:…` / `sha256:…`，
   * 由 `submitSelfUpdateRequest` 统一收敛成裸 hex（与升级任务 `targetDigest` 同形态）。
   */
  candidateDigest: z.string().min(8).max(512),
});

/**
 * 更新中心（PLAN-github-distribution-and-updates §9）。管理员可：
 * - 读取/更新自动更新策略（渠道、维护窗口、pin、排除）。
 * - 求解完整部署计划（内核 + 扩展 + 依赖），得到阻止原因或可投递任务。
 * - 投递升级任务到实例私有通道（updater 认领执行）。
 * - 查看 updater 状态投影与历史结果。
 *
 * 所有操作需管理员权限并写审计；投递前对「需人工授权」的变更强制 `acknowledge`。
 */
export async function adminUpdateRoutes(app: FastifyInstance): Promise<void> {
  const prisma = () => getPrisma();

  app.get(
    '/admin/updates/policy',
    { preHandler: adminOnly, schema: { security: [{ bearerAuth: [] }] } },
    async () => ({ policy: await readUpdatePolicy(prisma()) }),
  );

  app.put(
    '/admin/updates/policy',
    { preHandler: adminOnly, schema: { security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      const parsed = policySchema.safeParse(request.body ?? {});
      if (!parsed.success)
        return reply.code(400).send({
          code: 'updates.policy.invalid',
          error: '策略字段无效',
          issues: parsed.error.issues,
        });
      const saved = await saveUpdatePolicy(
        prisma(),
        // `maintenanceWindow: null` = 清除窗口；`Partial<UpdatePolicy>` 不容许 null，
        // 但 `saveUpdatePolicy` 的归一化层把它当作「不设窗口」处理。
        parsed.data as unknown as Partial<UpdatePolicy>,
        request.user?.id ?? null,
      );
      await writeAudit({
        action: 'updates.policy.update',
        resource: 'update-policy',
        meta: { policy: JSON.parse(JSON.stringify(saved)) },
        ...auditContext(request),
      });
      return { policy: saved };
    },
  );

  /**
   * 读取 updater 状态投影 + 当前策略 + 目录状态。
   *
   * **完全只读、零出网**：目录信息取自刷新协调器的内存快照。旧实现在这里调用
   * `updateCatalogContext()` → `ensureCurrent()`，进程重启后的第一次进页面就会卡在
   * GitHub 请求上（与 `refresh-service` 的「渲染路径不出网」契约矛盾）。
   * 真正的联网动作是 `POST /admin/updates/check`。
   */
  app.get(
    '/admin/updates/status',
    { preHandler: adminOnly, schema: { security: [{ bearerAuth: [] }] } },
    async () => {
      const [status, policy] = await Promise.all([readUpdaterStatus(), readUpdatePolicy(prisma())]);
      const catalog = readCatalogSnapshot();
      return {
        status,
        policy,
        catalogState: catalog.state,
        catalogConfigured: catalog.state !== 'unconfigured',
        catalogExpired: catalog.expired,
        catalogFailure: catalog.failure,
        catalogRepository: catalog.repository,
        catalogChannel: catalog.channel,
        catalogSequence: catalog.sequence,
        catalogGeneratedAt: catalog.generatedAt,
        lastCheckedAt: catalog.lastCheckedAt,
        cooldownMs: catalog.cooldownMs,
        carrier: env.DISTRIBUTION_UPDATE_CARRIER,
        instanceId: updateInstanceId(),
      };
    },
  );

  /**
   * 检查更新：强制刷新一次签名目录（显式动作）。
   *
   * - **单飞**：并发点击共享同一个在途请求（刷新协调器保证），不会 N 个管理员 = N 次 GitHub。
   * - **冷却**：失败退避期内、或刚成功后的最短间隔内，直接回 `throttled` + `retryAtMs`，
   *   不发任何请求——否则「检查更新」会退化成无限的 GitHub 触发器。
   * - **失败不降级**：验签失败/回放拒绝/限流一律原样上报 `catalog.failure`，
   *   不返回部分目录，也不把旧快照当新结果。
   */
  app.post(
    '/admin/updates/check',
    { preHandler: adminOnly, schema: { security: [{ bearerAuth: [] }] } },
    async (request) => {
      const service = getCatalogRefresh();
      if (!service) {
        return {
          checked: false,
          throttled: false,
          retryAtMs: 0,
          catalog: readCatalogSnapshot(),
          plan: null,
        };
      }
      const cooldownMs = service.cooldownRemainingMs();
      if (cooldownMs > 0) {
        return {
          checked: false,
          throttled: true,
          retryAtMs: cooldownMs,
          catalog: readCatalogSnapshot(),
          plan: null,
        };
      }
      const result = await service.refresh();
      await writeAudit({
        action: 'updates.catalog.check',
        resource: 'distribution',
        ...auditContext(request),
        meta: {
          ok: result.resolved !== null,
          sequence: result.resolved?.sequence ?? null,
          failure: result.failure?.kind ?? null,
        },
      });
      // 拿到可用快照就顺手求解一次：管理员点「检查更新」想看到的正是「有没有得升」。
      let solved: Record<string, unknown> | null = null;
      if (result.resolved) {
        const entry = await solvePlan();
        if (entry) solved = planResponse(entry.outcome, entry.expired);
      }
      return {
        checked: true,
        throttled: false,
        retryAtMs: 0,
        catalog: readCatalogSnapshot(),
        plan: solved,
      };
    },
  );

  /** 求解完整部署计划（不改任何状态）。 */
  app.post(
    '/admin/updates/plan',
    { preHandler: adminOnly, schema: { security: [{ bearerAuth: [] }] } },
    async (_request, reply) => {
      const entry = await solvePlan();
      if (!entry) return catalogUnavailable(reply);
      return planResponse(entry.outcome, entry.expired);
    },
  );

  /** 投递升级任务（求解成功且已确认授权变更时）。 */
  app.post(
    '/admin/updates/submit',
    { preHandler: adminOnly, schema: { security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      const parsed = installSchema.safeParse(request.body ?? {});
      if (!parsed.success)
        return reply.code(400).send({ error: '请求无效', issues: parsed.error.issues });
      const entry = await solvePlan(parsed.data.idempotencyKey);
      if (!entry) return catalogUnavailable(reply);
      if (!entry.outcome.ok) return planResponse(entry.outcome, entry.expired);
      // 过期目录可以看、可以算，但**默认不得**据此投递新任务（PLAN §3.3）。
      if (entry.expired && !parsed.data.allowExpired) {
        return reply.code(409).send({
          ok: false,
          code: 'updates.catalog_expired',
          catalogExpired: true,
          error: '目录快照已过期：请先「检查更新」，或显式勾选「仍按过期目录投递」',
        });
      }
      if (requiresAuthorization(entry.outcome.plan) && !parsed.data.acknowledge) {
        return reply.code(409).send({
          error: '计划包含权限增加或不可逆迁移，需显式确认后提交',
          code: 'updates.authorization_required',
          requiresAcknowledge: true,
        });
      }
      await submitUpdateTask(updateChannelRoot(), entry.outcome.task);
      await writeAudit({
        action: 'updates.task.submit',
        resource: 'update-task',
        resourceId: entry.outcome.task.idempotencyKey,
        meta: {
          planDigest: entry.outcome.task.planDigest,
          targetDigest: entry.outcome.task.targetDigest,
          packages: entry.outcome.plan.packages.length,
          acknowledged: parsed.data.acknowledge,
          catalogExpired: entry.expired,
        },
        ...auditContext(request),
      });
      // 更新任务的执行是异步的（updater 在实例私有通道取任务），因此这里只回执
      // 「已投递」。结果由 `/admin/updates/results` 与运行日志呈现。
      const actorId = request.user?.id;
      if (actorId) {
        await notifyUserBestEffort(
          { notifications: app.notifications, logger: request.log },
          {
            userId: actorId,
            type: 'system.update.submit',
            title: '更新任务已提交',
            body: `已投递 ${entry.outcome.plan.packages.length} 个包的升级任务，完成后可在更新中心查看结果。`,
            link: '/admin/updates',
            data: {
              kind: 'update',
              action: 'submit',
              idempotencyKey: entry.outcome.task.idempotencyKey,
              planDigest: entry.outcome.task.planDigest,
              packages: entry.outcome.plan.packages.length,
            },
            status: 'info',
          },
        );
      }
      return reply.code(202).send({
        submitted: true,
        idempotencyKey: entry.outcome.task.idempotencyKey,
        planDigest: entry.outcome.task.planDigest,
        catalogExpired: entry.expired,
      });
    },
  );

  /** 最近结果历史（updater 回写投影）。 */
  app.get(
    '/admin/updates/results',
    { preHandler: adminOnly, schema: { security: [{ bearerAuth: [] }] } },
    async () => ({ results: await listTaskResults(updateChannelRoot(), updateInstanceId()) }),
  );

  app.get(
    '/admin/updates/results/:key',
    { preHandler: adminOnly, schema: { security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      const params = z.object({ key: z.string().min(1).max(128) }).safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: '幂等键无效' });
      const result = await readTaskResult(updateChannelRoot(), updateInstanceId(), params.data.key);
      if (!result) return reply.code(404).send({ error: '结果不存在或尚未回写' });
      return { result };
    },
  );

  /**
   * updater 自升级（§5.2「updater 自己的更新」）。
   *
   * 执行核心在 `apps/updater`，内核只负责**发起**：写一次共享卷上的请求文件，
   * 由 updater 在无在途任务时消费（有在途保留、不并行）。此前这条写入路径不存在，
   * 所以执行能力虽齐备却不可达。
   */
  app.get(
    '/admin/updates/self-update',
    { preHandler: adminOnly, schema: { security: [{ bearerAuth: [] }] } },
    async () => ({ request: await readSelfUpdateRequest() }),
  );

  app.post(
    '/admin/updates/self-update',
    { preHandler: adminOnly, schema: { security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      const parsed = selfUpdateSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: '请求无效', issues: parsed.error.issues });
      }
      try {
        const submitted = await submitSelfUpdateRequest({
          candidateDigest: parsed.data.candidateDigest,
          requestedBy: request.user?.id ?? 'admin',
        });
        await writeAudit({
          action: 'updates.self-update.submit',
          resource: 'updater',
          resourceId: submitted.request.candidateDigest,
          meta: { candidateDigest: submitted.request.candidateDigest },
          ...auditContext(request),
        });
        return reply.code(202).send({ submitted: true, request: submitted.request });
      } catch (err) {
        if (err instanceof SelfUpdateRequestError) {
          // 在途任务/已有待执行请求是「当前状态不允许」，不是请求格式问题。
          const status = err.kind === 'invalid-digest' ? 400 : 409;
          return reply.code(status).send({ error: err.message, reason: err.kind });
        }
        throw err;
      }
    },
  );

  app.delete(
    '/admin/updates/self-update',
    { preHandler: adminOnly, schema: { security: [{ bearerAuth: [] }] } },
    async (request) => {
      const cleared = await clearSelfUpdateRequest();
      if (cleared) {
        await writeAudit({
          action: 'updates.self-update.cancel',
          resource: 'updater',
          ...auditContext(request),
        });
      }
      return { cleared };
    },
  );

  async function solvePlan(idempotencyKey?: string): Promise<PlanEntry | null> {
    const context = await updateCatalogContext();
    if (!context) return null;
    const policy = await readUpdatePolicy(prisma());
    const status = await readUpdaterStatus();
    const kernelCandidates = await loadKernelCandidates(context);
    const outcome = await buildUpdatePlan({
      prisma: prisma(),
      catalog: context.catalog,
      policy,
      instanceId: updateInstanceId(),
      baselineGeneration: status?.generation ?? 0,
      kernelCandidates,
      carrier: env.DISTRIBUTION_UPDATE_CARRIER,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    return { outcome, expired: context.expired };
  }
}

/** 求解结果 + 目录新鲜度（过期目录可求解、可展示，但不默认允许投递）。 */
interface PlanEntry {
  outcome: PlanOutcome;
  expired: boolean;
}

/**
 * 目录不可用时的显式错误。
 *
 * 旧实现把「未配置 / 首次拉取失败 / 验签失败 / 回放拒绝」四种情况都回同一句
 * 「未配置远程目录」，管理员完全不知道该去改配置还是该重试。
 */
function catalogUnavailable(reply: FastifyReply): FastifyReply {
  const catalog = readCatalogSnapshot();
  const unconfigured = catalog.state === 'unconfigured';
  return reply.code(409).send({
    ok: false,
    code: unconfigured ? 'updates.catalog_unconfigured' : 'updates.catalog_unavailable',
    error: unconfigured
      ? '未配置远程目录（离线模式）：请在「设置 · 应用市场与分发源」启用目录仓'
      : `远程目录暂不可用${catalog.failure ? `（${catalog.failure.message}）` : ''}`,
    catalog,
  });
}

/** 把求解结果映射为响应（阻止原因或计划摘要）。 */
function planResponse(outcome: PlanOutcome, catalogExpired: boolean): Record<string, unknown> {
  if (!outcome.ok) {
    return { ok: false, blocks: outcome.blocks, catalogExpired };
  }
  return {
    ok: true,
    catalogExpired,
    planDigest: outcome.task.planDigest,
    plan: outcome.plan,
    includesKernel: outcome.includesKernel,
    task: {
      instanceId: outcome.task.instanceId,
      baselineGeneration: outcome.task.baselineGeneration,
      targetDigest: outcome.task.targetDigest,
      idempotencyKey: outcome.task.idempotencyKey,
    },
    requiresAuthorization: requiresAuthorization(outcome.plan),
  };
}
