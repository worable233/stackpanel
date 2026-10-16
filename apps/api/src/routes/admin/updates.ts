import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  buildUpdatePlan,
  listTaskResults,
  readTaskResult,
  readUpdaterStatus,
  readUpdatePolicy,
  requiresAuthorization,
  saveUpdatePolicy,
  submitUpdateTask,
  updateCatalogContext,
  updateChannelRoot,
  updateInstanceId,
  type PlanOutcome,
  type UpdatePolicy,
} from '../../updates/index.ts';
import { auditContext, writeAudit } from '../../plugins/audit.ts';
import { getPrisma } from '../../plugins/prisma.ts';
import { requireAuth, requireRole } from '../../plugins/auth.ts';

const adminOnly = [requireAuth, requireRole('ADMIN')];

const policySchema = z.object({
  autoUpdate: z.boolean().optional(),
  channel: z.enum(['stable', 'beta']).optional(),
  autoUpdateKernel: z.boolean().optional(),
  excluded: z.array(z.string().min(1).max(128)).max(500).optional(),
  pinned: z.record(z.string().min(1).max(128), z.string().min(1).max(64)).optional(),
  maintenanceWindow: z
    .object({
      startHour: z.number().int().min(0).max(23),
      endHour: z.number().int().min(0).max(23),
    })
    .optional(),
  allowPermissionIncrease: z.boolean().optional(),
  allowIrreversibleMigration: z.boolean().optional(),
});

const installSchema = z.object({
  /** 显式确认包含需人工授权的变更（权限增加 / 不可逆迁移）。 */
  acknowledge: z.boolean().default(false),
  /** 可选固定幂等键。 */
  idempotencyKey: z.string().min(1).max(128).optional(),
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
        return reply.code(400).send({ error: '策略字段无效', issues: parsed.error.issues });
      const saved = await saveUpdatePolicy(
        prisma(),
        parsed.data as Partial<UpdatePolicy>,
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

  /** 读取 updater 状态投影 + 当前策略 + 是否配置了目录。 */
  app.get(
    '/admin/updates/status',
    { preHandler: adminOnly, schema: { security: [{ bearerAuth: [] }] } },
    async () => {
      const [status, policy, context] = await Promise.all([
        readUpdaterStatus(),
        readUpdatePolicy(prisma()),
        updateCatalogContext(),
      ]);
      return {
        status,
        policy,
        catalogConfigured: context !== null,
        catalogExpired: context?.expired ?? null,
        instanceId: updateInstanceId(),
      };
    },
  );

  /** 求解完整部署计划（不改任何状态）。 */
  app.post(
    '/admin/updates/plan',
    { preHandler: adminOnly, schema: { security: [{ bearerAuth: [] }] } },
    async (_request, reply) => {
      const outcome = await plan();
      if (!outcome) {
        return reply.code(409).send({ error: '未配置远程目录，无法求解远程更新计划' });
      }
      return planResponse(outcome);
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
      const outcome = await plan(parsed.data.idempotencyKey);
      if (!outcome) {
        return reply.code(409).send({ error: '未配置远程目录，无法提交远程更新任务' });
      }
      if (!outcome.ok) return planResponse(outcome);
      if (requiresAuthorization(outcome.plan) && !parsed.data.acknowledge) {
        return reply.code(409).send({
          error: '计划包含权限增加或不可逆迁移，需显式确认后提交',
          requiresAcknowledge: true,
        });
      }
      await submitUpdateTask(updateChannelRoot(), outcome.task);
      await writeAudit({
        action: 'updates.task.submit',
        resource: 'update-task',
        resourceId: outcome.task.idempotencyKey,
        meta: {
          planDigest: outcome.task.planDigest,
          targetDigest: outcome.task.targetDigest,
          packages: outcome.plan.packages.length,
        },
        ...auditContext(request),
      });
      return reply.code(202).send({
        submitted: true,
        idempotencyKey: outcome.task.idempotencyKey,
        planDigest: outcome.task.planDigest,
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

  async function plan(idempotencyKey?: string): Promise<PlanOutcome | null> {
    const context = await updateCatalogContext();
    if (!context) return null;
    const policy = await readUpdatePolicy(prisma());
    const status = await readUpdaterStatus();
    return buildUpdatePlan({
      prisma: prisma(),
      catalog: context.catalog,
      policy,
      instanceId: updateInstanceId(),
      baselineGeneration: status?.generation ?? 0,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  }
}

/** 把求解结果映射为响应（阻止原因或计划摘要）。 */
function planResponse(outcome: PlanOutcome): Record<string, unknown> {
  if (!outcome.ok) {
    return { ok: false, blocks: outcome.blocks };
  }
  return {
    ok: true,
    planDigest: outcome.task.planDigest,
    plan: outcome.plan,
    task: {
      instanceId: outcome.task.instanceId,
      baselineGeneration: outcome.task.baselineGeneration,
      targetDigest: outcome.task.targetDigest,
      idempotencyKey: outcome.task.idempotencyKey,
    },
    requiresAuthorization: requiresAuthorization(outcome.plan),
  };
}
