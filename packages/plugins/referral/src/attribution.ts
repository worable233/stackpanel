import { ExtensionUniqueViolation, type ExtensionInstance } from '@stackpanel/sdk';
import { findActiveCode, bumpSignupCount } from './codes';
import { context } from './context';
import { recordModel, type ReferralConfig, type ReferralRecord } from './data';
import { awardInvitee, awardInviter, resolveInviterReward } from './rewards';

/**
 * 注册事件里的归因入口。
 *
 * 这个函数由 `user.registered` 事件驱动，而内核事件总线的订阅者 Promise **不被
 * await**：任何同步抛出或未捕获的 rejection 都会变成发布者进程里的孤儿异常。
 * 所以这里把整个流程包在 try/catch 里，失败只记日志，绝不向外抛。
 */
export async function attributeRegistration(input: {
  userId: string;
  email: string;
  affid: string | null;
  ip: string | null;
  config: ReferralConfig;
}): Promise<void> {
  const pluginCtx = context();
  const { userId, email, affid, ip, config } = input;

  if (!config.enabled || !affid) return;
  if (config.inviteeRewardAmount <= 0 && config.rewardAmount <= 0) return;

  try {
    const code = await findActiveCode(affid);
    if (!code) {
      pluginCtx.logger.warn(`referral: 无效或被停用的推广码 ${affid}`);
      return;
    }
    // 自己推广自己：不建记录，也不发任何奖励。
    if (code.spec.ownerId === userId) {
      pluginCtx.logger.warn(`referral: 拒绝自我推广 ${userId}`);
      return;
    }

    const extensions = pluginCtx.extensions;
    const existing = await extensions.get<ReferralRecord>(recordModel, userId);
    if (existing) return; // 首次点击固定归因：已有记录就不再争抢。

    const inviterId = code.spec.ownerId;
    const rejected = await checkRisk(config, inviterId, ip);

    const spec: ReferralRecord = {
      code: code.spec.code,
      inviterId,
      inviteeId: userId,
      inviteeEmail: email,
      trigger: config.trigger,
      inviterState: rejected ? 'rejected' : 'pending',
      inviteeState: 'none',
      freezeUntil:
        config.trigger === 'register_frozen' && !rejected
          ? Date.now() + Math.max(0, config.freezeDays) * 86_400_000
          : 0,
      rewardAmount: rejected ? 0 : resolveInviterReward(code.spec, config),
      inviteeRewardAmount: 0,
      registerIp: ip ?? '',
      qualifiedOrderId: null,
      qualifiedAt: null,
      paidAt: null,
    };

    let record: ExtensionInstance<ReferralRecord>;
    try {
      // 用 inviteeId 当实例名：唯一索引与实例 id 同时保证一人一条记录。
      record = await extensions.create<ReferralRecord>(recordModel, spec, {
        name: userId,
        ownerId: inviterId,
      });
    } catch (error) {
      if (error instanceof ExtensionUniqueViolation) return; // 并发下已被抢先归因。
      throw error;
    }

    // 风控拒绝：两侧都不发奖，只保留记录供后台排查（设计文档 §8）。
    if (rejected) return;

    // 被邀请人奖励与触发档位无关：归因一旦成立就发。
    await awardInvitee(record, config);

    if (config.trigger === 'register') {
      await awardInviter(record, code.spec, config);
    }
    // first_order 要等订单；register_frozen 要等冻结期，两者都留给后续路径。
    await bumpSignupCount(code.name);
    pluginCtx.logger.info(`referral: 已归因 ${userId} -> ${inviterId} (${code.spec.code})`);
  } catch (error) {
    pluginCtx.logger.error(`referral: 归因失败 ${userId} ${String(error)}`);
  }
}

/**
 * 风控判定：命中任意一条就拒绝发奖（记录仍会落库，便于后台排查）。
 *
 * 返回 true 表示该归因被判为可疑。
 */
async function checkRisk(
  config: ReferralConfig,
  inviterId: string,
  ip: string | null,
): Promise<boolean> {
  const extensions = context().extensions;

  if (config.maxInvitesPerUser > 0) {
    const { total } = await extensions.list<ReferralRecord>(recordModel, {
      where: { inviterId: { eq: inviterId }, inviterState: { eq: 'paid' } },
      page: 1,
      pageSize: 1,
    });
    if (total >= config.maxInvitesPerUser) return true;
  }

  if (config.sameIpLimit > 0 && ip) {
    const { total } = await extensions.list<ReferralRecord>(recordModel, {
      where: { registerIp: { eq: ip } },
      page: 1,
      pageSize: 1,
    });
    if (total >= config.sameIpLimit) return true;
  }

  return false;
}
