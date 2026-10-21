import type {
  ProvisionContext,
  ProvisionResult,
  ProviderServiceContext,
  ServiceDetail,
} from '@stackpanel/sdk';
import { isExtensionNotFound, isExtensionVersionConflict } from '@stackpanel/sdk';
import { context, extensions, logger, MembershipError, messageOf } from './context.js';
import { MEMBERSHIP_KIND, membershipModel, type MembershipGrantData } from './data.js';

/** 到期清扫每批处理的行数（集群任务，分批避免长时间锁表）。 */
export const SWEEP_BATCH = 100;

/** 清扫间隔：一小时。到期判定在读路径完成，这个频率只影响数据清理与通知。 */
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** 禁止作为会员权益授予的权限组。 */
const FORBIDDEN_GROUPS = new Set(['group_admin']);

/** 商品 metadata 中的会员配置（由 {@link membershipConfigSchema} 校验）。 */
export interface MembershipConfig {
  /** 授予的权限组 id。 */
  groupId: string;
  /** 是否允许「无计费周期 → 永久会员」。默认 false。 */
  allowPermanent: boolean;
}

/**
 * 从商品 metadata 读取会员配置。
 *
 * 商品类型配置存在 `metadata` 顶层（与发卡/云服务器插件一致），由 store 在
 * 创建/编辑商品时用类型插件的 `configSchema` 校验，所以这里只需要读。
 */
export function readMembershipConfig(metadata: unknown): MembershipConfig {
  if (metadata === null || typeof metadata !== 'object') {
    throw new MembershipError(400, '商品未配置会员权益');
  }
  const groupId = (metadata as Record<string, unknown>)['groupId'];
  if (typeof groupId !== 'string' || groupId.trim() === '') {
    throw new MembershipError(400, '商品未配置会员权益');
  }
  return {
    groupId: groupId.trim(),
    allowPermanent: (metadata as Record<string, unknown>)['allowPermanent'] === true,
  };
}

/** 到期时间归一化：`undefined`/非法值一律视为永久（null）。 */
function toExpiry(value: string | null | undefined): Date | null {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * 授予会员权益（幂等）。
 *
 * 幂等键 = `orderId + productId`：履约任务至少一次投递，重复调用不得产生第二条
 * 记录、也不得把已撤销的权益重新激活。已存在的 ACTIVE 记录会按新到期时间续授
 * （续费路径），但不会因为一次重放就延长。
 */
export async function grantMembership(
  ctx: ProvisionContext,
  config: MembershipConfig,
): Promise<{ grant: MembershipGrantData; name: string; version: number }> {
  if (FORBIDDEN_GROUPS.has(config.groupId)) {
    // 可购买的商品绝不能授予管理员组——那等于把提权做成 SKU。
    throw new MembershipError(400, '商品未配置会员权益');
  }
  const expiresAt = toExpiry(ctx.expiresAt);
  if (!expiresAt && !config.allowPermanent) {
    // 会员是「一段时间内的权益」。没有到期时间又没有显式允许永久，说明商品的
    // 计费周期没配好（例如可配置商品漏了 cycles）。此时授予永久会员是灾难性的：
    // 用户付一次钱就永久解锁。宁可失败让人来配。
    throw new MembershipError(400, '商品未配置会员权益');
  }
  const existing = await findGrantByOrder(ctx.orderId, ctx.productId);
  if (existing) {
    // 幂等：同一订单 + 商品只授予一次。已撤销的也**不复活**——否则一条迟到的
    // 履约重放就能把已到期的会员重新打开，等于免费续期。
    return existing;
  }
  const now = new Date();
  const startsAt = now.toISOString();
  // 先写内核成员关系（权威授权），再落本插件记录（撤销依据）。
  // 顺序不能反：若先落记录再授权失败，会留下「记录说已授予、实际没授权」的脏数据，
  // 清扫时又找不到可撤销的行。
  const granted = await context().auth.grantUserGroup({
    userId: ctx.userId,
    groupId: config.groupId,
    expiresAt,
  });
  // 记录以**内核实际生效的到期时间**为准：若用户本来就有该组的永久成员关系
  // （管理员手工授予），内核不会把它降级，此时记录也应是永久，否则清扫会误发
  // 「会员已到期」通知，而用户其实仍然有效。
  const effectiveExpiry = granted.expiresAt ? new Date(granted.expiresAt) : null;
  const spec: MembershipGrantData = {
    userId: ctx.userId,
    groupId: config.groupId,
    productId: ctx.productId,
    orderId: ctx.orderId,
    startsAt,
    expiresAt: effectiveExpiry ? effectiveExpiry.toISOString() : null,
    expiresAtMs: effectiveExpiry ? effectiveExpiry.getTime() : null,
    status: 'ACTIVE',
  };
  const created = await extensions().create<MembershipGrantData>(membershipModel, spec);
  return { grant: created.spec, name: created.name, version: created.version };
}

/** 按订单 + 商品查找授予记录（重放幂等的依据）。 */
export async function findGrantByOrder(
  orderId: string,
  productId: string,
): Promise<{ grant: MembershipGrantData; name: string; version: number } | null> {
  const page = await extensions().list<MembershipGrantData>(membershipModel, {
    where: { orderId: { eq: orderId } },
    orderBy: { field: 'createdAt' },
    page: 1,
    pageSize: 20,
  });
  const hit = page.items.find((item) => item.spec.productId === productId);
  if (!hit) return null;
  return { grant: hit.spec, name: hit.name, version: hit.version };
}

/** 按「用户 + 组 + 订单」定位授予记录的实例 id。 */
export async function findGrantByName(
  userId: string,
  groupId: string,
  orderId: string,
): Promise<string | null> {
  const rows = await extensions().listAll<MembershipGrantData>(membershipModel, {
    where: { userId: { eq: userId }, groupId: { eq: groupId }, orderId: { eq: orderId } },
  });
  return rows[0]?.name ?? null;
}

/**
 * 撤销一条权益。
 *
 * 安全约束：只有当内核成员关系上的 `expiresAt` 与记录一致时才删除——如果管理员
 * 中途把该组改成永久（或改成别的到期时间），说明有人接管了这条关系，插件不得
 * 越权撤销。
 */
export async function revokeMembership(
  name: string,
  reason: 'expired' | 'manual' | 'replaced',
): Promise<{ revoked: boolean; grant: MembershipGrantData | null }> {
  const instance = await extensions().get<MembershipGrantData>(membershipModel, name);
  if (!instance) return { revoked: false, grant: null };
  if (instance.spec.status === 'REVOKED') return { revoked: false, grant: instance.spec };
  const grant = instance.spec;
  const grants = await context().auth.listUserGroupGrants(grant.userId);
  const live = grants.find((row) => row.groupId === grant.groupId);
  const recordedExpiry = grant.expiresAt;
  const liveExpiry = live?.expiresAt ?? null;
  // 关系还在，且到期时间仍归本插件管理 → 撤销。否则只标记记录，不碰内核关系。
  if (live && liveExpiry === recordedExpiry) {
    await context().auth.revokeUserGroup(grant.userId, grant.groupId);
  } else if (live && liveExpiry !== recordedExpiry) {
    logger().info(
      `store-product-membership: 保留 ${grant.userId}/${grant.groupId}（到期时间已被外部改为 ${liveExpiry ?? '永久'}）`,
    );
  }
  try {
    await extensions().update<MembershipGrantData>(
      membershipModel,
      name,
      {
        ...grant,
        status: 'REVOKED',
        revokedAt: new Date().toISOString(),
        revokeReason: reason,
      },
      { expectedVersion: instance.version },
    );
  } catch (error) {
    // 并发撤销：另一路已经写过，视为成功。
    if (!isExtensionVersionConflict(error) && !isExtensionNotFound(error)) throw error;
  }
  return { revoked: true, grant };
}

/**
 * 到期清扫：撤销 `expiresAtMs <= now` 的 ACTIVE 权益。
 *
 * 只做「记录与数据清理 + 通知」。权益失效本身由内核读路径（`hasPermission` 等
 * 过滤过期成员）保证，因此本任务延迟或失败都不会让过期会员继续生效。
 */
export async function sweepExpired(now: Date = new Date()): Promise<number> {
  const page = await extensions().list<MembershipGrantData>(membershipModel, {
    where: {
      status: { eq: 'ACTIVE' },
      // 永久会员的 expiresAtMs 为 null，不命中范围条件，永远不会被清扫。
      expiresAtMs: { lte: now.getTime() },
    },
    orderBy: { field: 'expiresAtMs' },
    page: 1,
    pageSize: SWEEP_BATCH,
  });
  const due = page.items.filter((item) => {
    const ms = item.spec.expiresAtMs;
    return typeof ms === 'number' && ms <= now.getTime();
  });
  let revoked = 0;
  for (const item of due) {
    try {
      const result = await revokeMembership(item.name, 'expired');
      if (!result.revoked) continue;
      revoked += 1;
      await notifyExpired(result.grant).catch((error: unknown) => {
        logger().warn(
          `store-product-membership: 到期通知失败（${item.name}）：${messageOf(error)}`,
        );
      });
    } catch (error) {
      logger().warn(`store-product-membership: 撤销到期权益失败（${item.name}）：${messageOf(error)}`);
    }
  }
  return revoked;
}

/** 续费：把已授予的权益延长到新的到期时间（与商店服务的到期时间保持一致）。 */
export async function extendMembership(
  userId: string,
  orderId: string | null,
  groupId: string,
  newExpiresAt: string,
): Promise<boolean> {
  const at = toExpiry(newExpiresAt);
  if (!at) return false;
  const grants = await extensions().listAll<MembershipGrantData>(membershipModel, {
    where: { userId: { eq: userId }, groupId: { eq: groupId }, status: { eq: 'ACTIVE' } },
  });
  const target = grants.find((item) => (orderId ? item.spec.orderId === orderId : true));
  if (!target) return false;
  const granted = await context().auth.grantUserGroup({ userId, groupId, expiresAt: at });
  // 与授予一致：以内核实际生效的到期时间为准（用户可能本来就有永久成员）。
  const effective = granted.expiresAt ? new Date(granted.expiresAt) : null;
  await extensions().update<MembershipGrantData>(
    membershipModel,
    target.name,
    {
      ...target.spec,
      expiresAt: effective ? effective.toISOString() : null,
      expiresAtMs: effective ? effective.getTime() : null,
    },
    { expectedVersion: target.version },
  );
  return true;
}

/** 列出某用户的有效权益（已过期的记录不返回）。 */
export async function listActiveGrants(userId: string): Promise<MembershipGrantData[]> {
  const rows = await extensions().listAll<MembershipGrantData>(membershipModel, {
    where: { userId: { eq: userId }, status: { eq: 'ACTIVE' } },
  });
  const now = Date.now();
  return rows
    .map((row) => row.spec)
    .filter((grant) => grant.expiresAtMs === null || grant.expiresAtMs > now);
}

/** 列出某用户全部权益记录（含已撤销，供「我的会员」历史展示）。 */
export async function listAllGrants(userId: string): Promise<MembershipGrantData[]> {
  const rows = await extensions().listAll<MembershipGrantData>(membershipModel, {
    where: { userId: { eq: userId } },
  });
  return rows
    .map((row) => row.spec)
    .sort((a, b) => (b.startsAt > a.startsAt ? 1 : b.startsAt < a.startsAt ? -1 : 0));
}

/** 权益的服务详情（「我的服务」里点开会员商品看到的内容）。 */
export async function membershipDetail(service: ProviderServiceContext): Promise<ServiceDetail> {
  const fields: ServiceDetail['fields'] = [];
  const userId = service.service.userId;
  const grants = await listActiveGrants(userId);
  // 只展示本服务对应的权益：同一用户可能同时持有多个会员商品，把别的订单的
  // 等级混进来会让人以为「这个服务」的等级被改了。
  const scoped = service.service.orderId
    ? grants.filter((grant) => grant.orderId === service.service.orderId)
    : grants;
  if (scoped.length === 0) {
    fields.push({ label: '状态', value: '会员权益已结束' });
    return { title: '会员', status: 'ACTIVE', fields };
  }
  const groups = await context().auth.listUserGroups(userId);
  for (const grant of scoped) {
    const group = groups.find((candidate) => candidate.id === grant.groupId);
    fields.push({ label: '会员等级', value: group?.name ?? grant.groupId });
    fields.push({
      label: '到期时间',
      value: grant.expiresAt ? grant.expiresAt.slice(0, 10) : '永久有效',
    });
    if (group?.discount != null && group.discount > 0) {
      fields.push({ label: '会员折扣', value: `${group.discount}%` });
    }
  }
  return { title: '会员', status: 'ACTIVE', fields };
}

/** 到期通知（站内）。通知服务不可用时静默，不影响撤销。 */
async function notifyExpired(grant: MembershipGrantData | null): Promise<void> {
  if (!grant) return;
  await context().notifications.create({
    userId: grant.userId,
    type: 'membership.expired',
    title: '会员已到期',
    body: grant.expiresAt
      ? `你的会员权益已于 ${grant.expiresAt.slice(0, 10)} 到期，续费后可继续享受会员折扣与专属权限。`
      : '你的会员权益已结束。',
    link: '/account/services',
    data: { groupId: grant.groupId, productId: grant.productId, orderId: grant.orderId },
    status: 'info',
  });
}

/** 商品类型标识（store 按 fulfillmentTypes 分派）。 */
export const MEMBERSHIP_FULFILLMENT_TYPE = 'membership';

/** 供测试与诊断读取的模型 kind。 */
export { MEMBERSHIP_KIND, membershipModel };

/** provision 的结果封装：统一把失败转成 FAILED，不抛给 store 重试。 */
export async function provisionMembership(ctx: ProvisionContext): Promise<ProvisionResult> {
  const config = readMembershipConfig(ctx.product.metadata);
  const created = await grantMembership(ctx, config);
  const expiresAt = created.grant.expiresAt;
  return {
    status: 'ACTIVE',
    providerServiceId: null,
    runtime: {
      membership: {
        groupId: created.grant.groupId,
        startsAt: created.grant.startsAt,
        expiresAt,
      },
    },
    ...(expiresAt
      ? { message: `会员权益已开通，有效期至 ${expiresAt.slice(0, 10)}` }
      : { message: '会员权益已开通（永久）' }),
  };
}

/**
 * 开通成功的站内通知（幂等键按订单 + 商品，重放合并为一条）。
 *
 * 由 index.ts 在 provision 之后调用；失败只告警——权益已经授予，通知丢了不该
 * 让履约任务重试（重试会再走一遍授予）。
 */
export async function notifyGranted(ctx: ProvisionContext): Promise<void> {
  const found = await findGrantByOrder(ctx.orderId, ctx.productId);
  if (!found) return;
  const grant = found.grant;
  await context().notifications.create({
    userId: grant.userId,
    type: 'membership.granted',
    title: '会员已开通',
    body: grant.expiresAt
      ? `「${ctx.product.name}」已开通，有效期至 ${grant.expiresAt.slice(0, 10)}。`
      : `「${ctx.product.name}」已开通，永久有效。`,
    link: '/account/services',
    data: { groupId: grant.groupId, productId: grant.productId, orderId: grant.orderId },
    status: 'success',
    dedupeKey: `membership:granted:${grant.orderId}:${grant.productId}`,
  });
}
