import { EXTENSION_POINTS, definePlugin, PluginError } from '@stackpanel/sdk';
import type {
  FulfillmentProvider,
  JobContext,
  HttpReply,
  HttpRequest,
  NotificationTypeDefinition,
  ProductConfigField,
  ProductTypeProvider,
  ProviderServiceContext,
  ServiceActionResult,
  ServiceRenewalInput,
  ServiceDetail,
} from '@stackpanel/sdk';
import { z } from 'zod';
import { bindContext, clearContext, context, logger, MembershipError } from './context.js';
import { membershipModel } from './data.js';
import {
  extendMembership,
  findGrantByName,
  listActiveGrants,
  listAllGrants,
  membershipDetail,
  MEMBERSHIP_FULFILLMENT_TYPE,
  notifyGranted,
  provisionMembership,
  revokeMembership,
  sweepExpired,
  SWEEP_INTERVAL_MS,
} from './membership.js';

/**
 * 会员商品类型插件。
 *
 * 权益载体复用内核的权限组：`user_groups.expiresAt` 表示限时成员，到期后由
 * 内核读路径（`hasPermission` / `listUserGroups` / `permissionsOf`）立即失效，
 * 不依赖任何定时任务。本插件负责「卖出去 → 授予 → 到期撤销 → 续费延长」这条链。
 *
 * 为什么不新建 membership 表：会员的核心价值是「解锁已有权限」。另建一套会员表
 * 就要在所有权限判定点并联第二套判定，两套口径迟早漂移；复用权限组则天然复用
 * 折扣（`PermissionGroup.discount`）、路由鉴权与后台组管理。
 */

const configSchema = z
  .object({
    /** 授予的权限组 id。 */
    groupId: z.string().min(1).max(191),
    /**
     * 允许永久会员（无到期时间）。默认 false：会员商品的计费周期没配好时
     * 应该开通失败，而不是静默授予永久权益。
     */
    allowPermanent: z.boolean().optional(),
  })
  .passthrough();

const configFields: ProductConfigField[] = [
  {
    name: 'groupId',
    label: '会员权限组',
    type: 'select',
    required: true,
    help: '购买后用户会被加入该权限组，到期自动移出。组上的折扣即为会员折扣。',
    // 候选项由 store 在聚合商品类型时按当前权限组动态填充
    // （见 store/src/product-types.ts 的 optionsSource）。
    optionsSource: 'permissionGroups',
    options: [],
  },
  {
    name: 'allowPermanent',
    label: '允许永久会员',
    type: 'boolean',
    defaultValue: false,
    help: '关闭时，商品必须配置计费周期（否则开通失败）；开启后无周期的商品会授予永久会员。',
  },
];

const MEMBERSHIP_NOTIFICATION_TYPES: readonly NotificationTypeDefinition[] = [
  { type: 'membership.expired', category: 'membership', label: '会员已到期', order: 10 },
  { type: 'membership.granted', category: 'membership', label: '会员已开通', order: 20 },
];

const provider: FulfillmentProvider = {
  id: 'store-product-membership',
  name: '会员（本平台）',
  fulfillmentTypes: [MEMBERSHIP_FULFILLMENT_TYPE],

  async provision(ctx) {
    const result = await provisionMembership(ctx);
    // 通知是尽力而为：权益已授予，通知失败不该让履约任务重试（重试会再授予一次）。
    if (result.status === 'ACTIVE') {
      await notifyGranted(ctx).catch((error: unknown) => {
        logger().warn(`store-product-membership: 开通通知失败：${String(error)}`);
      });
    }
    return result;
  },

  async getDetail(service: ProviderServiceContext): Promise<ServiceDetail> {
    return membershipDetail(service);
  },

  /** 续费：store 已推进服务到期时间，这里把权限组成员的到期时间对齐。 */
  async renew(
    service: ProviderServiceContext,
    info: ServiceRenewalInput,
  ): Promise<ServiceActionResult | void> {
    const groupId = await resolveGroupId(service);
    const extended = await extendMembership(
      service.service.userId,
      service.service.orderId,
      groupId,
      info.newExpiresAt,
    );
    if (!extended) {
      // 没有可延长的授予记录：权益已被撤销或记录缺失。必须抛错让 store 记日志，
      // 不能静默吞掉——否则用户付了续费钱却没有任何权益。
      throw new MembershipError(409, '未找到可续期的会员权益，请联系客服');
    }
    // 以内核实际生效值为准：用户若本来就有该组的永久成员，续费不会把它变成限时。
    const live = await context()
      .auth.listUserGroupGrants(service.service.userId)
      .then((rows) => rows.find((row) => row.groupId === groupId))
      .catch(() => undefined);
    const effective = live?.expiresAt ?? info.newExpiresAt;
    return {
      message: live?.expiresAt === null ? '会员权益为永久有效' : `会员有效期已延长至 ${effective.slice(0, 10)}`,
    };
  },

  /**
   * 到期暂停：内核读路径已让过期权益失效（`expiresAt` 到点即不生效），这里只把
   * 本插件记录标记为撤销。`suspend` 在宽限期结束后才被调用，因此不承担「准时」责任。
   */
  async suspend(service: ProviderServiceContext): Promise<void> {
    await revokeByService(service, 'expired');
  },

  /** 终止：保留期内再次确认撤销（幂等）。 */
  async terminate(service: ProviderServiceContext): Promise<void> {
    await revokeByService(service, 'expired');
  },
};

const productType: ProductTypeProvider = {
  ...provider,
  label: '会员',
  configFields,
  configSchema,
};

const noQuery = z.object({}).passthrough();

/**
 * 本插件注册的内核任务。抽成函数以便 `jobs-contract.test.ts` 直接断言名字与频率。
 */
export function registerMembershipJobs(jobs: JobContext): void {
  // 到期清扫：撤销过期授予、清理内核成员关系、发到期通知。
  // 权益失效本身由内核读路径保证，所以这个任务的频率只影响清理与通知的及时性。
  jobs.handle('membership-sweep', async () => {
    const count = await sweepExpired();
    if (count > 0) logger().info(`store-product-membership: 撤销 ${count} 条到期会员权益`);
  });
  void jobs.schedule('membership-sweep', { everyMs: SWEEP_INTERVAL_MS }).catch((error: unknown) => {
    logger().warn(`store-product-membership: 排期到期清扫失败：${String(error)}`);
  });
}

export const storeProductMembershipPlugin = definePlugin({
  manifest: {
    id: 'store-product-membership',
    name: '会员商品类型',
    version: '0.1.0',
    description: '会员商品类型：付款授予限时权限组权益，到期自动撤权，续费自动延长。',
    requires: ['store'],
    permissions: [
      {
        key: 'store-product-membership.admin',
        name: '管理会员',
        description: '查看与撤销用户的会员权益（会员/权限组商品）。',
      },
    ],
    roleTemplates: [{ role: 'ADMIN', permissions: ['store-product-membership.admin'] }],
  },
  customModels: [membershipModel],
  routes: [
    {
      // 当前用户的会员权益（「我的会员」页面数据源）。
      method: 'GET',
      path: '/store-product-membership/me',
      auth: 'user',
      handler: handle(async (req: HttpRequest) => {
        noQuery.parse(req.query);
        const userId = req.user?.id;
        if (!userId) throw new MembershipError(401, '参数无效');
        const [active, all, groups] = await Promise.all([
          listActiveGrants(userId),
          listAllGrants(userId),
          context().auth.listUserGroups(userId),
        ]);
        const nameOf = (groupId: string): string =>
          groups.find((group) => group.id === groupId)?.name ?? groupId;
        return {
          active: active.map((grant) => ({
            groupId: grant.groupId,
            groupName: nameOf(grant.groupId),
            productId: grant.productId,
            orderId: grant.orderId,
            startsAt: grant.startsAt,
            expiresAt: grant.expiresAt,
          })),
          history: all.map((grant) => ({
            groupId: grant.groupId,
            productId: grant.productId,
            orderId: grant.orderId,
            startsAt: grant.startsAt,
            expiresAt: grant.expiresAt,
            status: grant.status,
            revokeReason: grant.revokeReason ?? null,
          })),
        };
      }),
    },
    {
      // 管理员撤销某条权益（售后退款/误授）。
      method: 'POST',
      path: '/store-product-membership/admin/grants/:id/revoke',
      auth: 'admin',
      permission: 'store-product-membership.admin',
      handler: handle(async (req: HttpRequest, reply: HttpReply) => {
        const id = req.params['id'];
        if (!id) throw new MembershipError(400, '参数无效');
        const result = await revokeMembership(id, 'manual');
        if (!result.grant) throw new MembershipError(404, '会员权益不存在');
        return reply.code(200).send({
          revoked: result.revoked,
          groupId: result.grant.groupId,
          userId: result.grant.userId,
        });
      }),
    },
  ],
  onActivate: (ctx) => {
    ctx.effect(() => {
      bindContext(ctx);
      return clearContext;
    });
    ctx.registerExtension(EXTENSION_POINTS.productType, productType);
    ctx.registerExtension(EXTENSION_POINTS.fulfillmentProvider, provider);
    for (const def of MEMBERSHIP_NOTIFICATION_TYPES) {
      ctx.registerExtension(EXTENSION_POINTS.notificationType, def);
    }
    registerMembershipJobs(ctx.jobs);
    ctx.logger.info('store-product-membership: activated');
  },
  onDeactivate: (ctx) => {
    ctx.logger.info('store-product-membership: deactivated');
  },
});

/**
 * 解析该服务对应的会员权益组。
 *
 * 优先用服务 runtime 里授予时写入的组：商品配置后来被改到别的组时，已售出的
 * 服务仍应按原组续费/撤销，否则会把用户续到别的等级上。
 */
async function resolveGroupId(service: ProviderServiceContext): Promise<string> {
  const runtime = service.service.runtime as
    | { membership?: { groupId?: unknown } }
    | null
    | undefined;
  const recorded = runtime?.membership?.groupId;
  if (typeof recorded === 'string' && recorded) return recorded;
  const grants = await context().auth.listUserGroupGrants(service.service.userId);
  const timed = grants.filter((grant) => grant.expiresAt !== null);
  if (timed.length === 1 && timed[0]) return timed[0].groupId;
  throw new MembershipError(409, '无法确定该服务的会员权益组');
}

/** 按服务找到本插件授予的记录并撤销（幂等）。 */
async function revokeByService(
  service: ProviderServiceContext,
  reason: 'expired' | 'manual',
): Promise<void> {
  const active = await listActiveGrants(service.service.userId);
  const byOrder = active.filter((grant) => grant.orderId === service.service.orderId);
  const groupId = await resolveGroupId(service).catch(() => null);
  const candidates = groupId ? byOrder.filter((grant) => grant.groupId === groupId) : byOrder;
  for (const grant of candidates) {
    const name = await findGrantByName(grant.userId, grant.groupId, grant.orderId);
    if (!name) continue;
    await revokeMembership(name, reason);
  }
}

function handle(handler: (req: HttpRequest, reply: HttpReply) => Promise<unknown>) {
  return async (req: HttpRequest, reply: HttpReply): Promise<unknown> => {
    try {
      return await handler(req, reply);
    } catch (error) {
      if (error instanceof MembershipError) {
        throw new PluginError(error.code, error.status, error.message);
      }
      throw error;
    }
  };
}

export default storeProductMembershipPlugin;
