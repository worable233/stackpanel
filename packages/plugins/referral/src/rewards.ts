import type { ExtensionInstance } from '@stackpanel/sdk';
import { context } from './context';
import { recordModel, type ReferralCode, type ReferralConfig, type ReferralRecord } from './data';

/**
 * 钱包流水里标记「这笔钱来自推广」的 referenceType。
 *
 * 幂等靠内核账本的 `@@unique([referenceType, referenceId])`：同一个归因记录的
 * 同一侧奖励只会入账一次，重复投递（事件重放、任务重试）不会多发钱。
 */
export const REFERRAL_REFERENCE_TYPE = 'REFERRAL';

/** 流水展示类型；钱包明细页对未知 type 会回退显示 note。 */
const LEDGER_TYPE_INVITER = 'REFERRAL_REWARD';
const LEDGER_TYPE_INVITEE = 'REFERRAL_INVITEE_REWARD';

/** Prisma 把唯一索引冲突报成 P2002。 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

/** 推广人这条记录该拿多少：单码覆盖优先，否则用全局默认。 */
export function resolveInviterReward(code: ReferralCode | null, config: ReferralConfig): number {
  const override = code?.rewardAmount ?? null;
  if (override !== null && Number.isSafeInteger(override) && override >= 0) return override;
  return config.rewardAmount;
}

type RecordInstance = ExtensionInstance<ReferralRecord>;

/**
 * 把一个归因记录推进到目标状态，并在需要时入账。
 *
 * 数据写入与钱包入账放在同一个 `ctx.tx` 里：要么「记录已结清 + 钱已到账」同时
 * 成立，要么都不成立，不会出现记录说已发但账上没钱（或反之）的中间态。
 */
async function settleRecord(
  record: RecordInstance,
  patch: Partial<ReferralRecord>,
  payout: {
    userId: string;
    amount: number;
    currency: string;
    referenceId: string;
    ledgerType: string;
    note: string;
  } | null,
): Promise<'paid' | 'already-paid'> {
  const pluginCtx = context();
  const nextSpec: ReferralRecord = { ...record.spec, ...patch };
  try {
    await pluginCtx.tx(async (tx) => {
      await tx.extensions.update<ReferralRecord>(recordModel, record.name, nextSpec, {
        expectedVersion: record.version,
      });
      if (payout && payout.amount > 0) {
        await tx.wallet.credit(payout.userId, payout.amount, payout.currency, {
          type: payout.ledgerType,
          referenceType: REFERRAL_REFERENCE_TYPE,
          referenceId: payout.referenceId,
          note: payout.note,
        });
      }
    });
    return 'paid';
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // 钱之前已经发过（幂等命中）。这里只把记录状态补齐，绝不重复入账。
    pluginCtx.logger.warn(`referral: 奖励已发放，跳过重复入账 ${payout?.referenceId ?? record.name}`);
    const latest = await pluginCtx.extensions.get<ReferralRecord>(recordModel, record.name);
    if (latest && latest.spec.inviterState !== nextSpec.inviterState) {
      await pluginCtx.extensions.update<ReferralRecord>(recordModel, record.name, nextSpec, {
        expectedVersion: latest.version,
      });
    }
    return 'already-paid';
  }
}

/**
 * 取记录的最新版本。
 *
 * 调用方手里的 `record` 可能是几步之前读到的快照（例如归因流程先发被邀请人
 * 奖励、再发推广人奖励，中间记录版本已经 +1）。直接用陈旧 version 走
 * `extensions.update` 必然触发乐观锁冲突。这里统一在写之前重读一次，让
 * 「读-改-写」始终基于最新版本。
 */
async function latestRecord(record: RecordInstance): Promise<RecordInstance> {
  const fresh = await context().extensions.get<ReferralRecord>(recordModel, record.name);
  return fresh ?? record;
}

/** 发放推广人奖励。已在 paid 状态的记录直接跳过。 */
export async function awardInviter(
  record: RecordInstance,
  code: ReferralCode | null,
  config: ReferralConfig,
): Promise<'paid' | 'already-paid' | 'skipped'> {
  const current = await latestRecord(record);
  if (current.spec.inviterState === 'paid') return 'already-paid';
  if (current.spec.inviterState === 'rejected') return 'skipped';

  const amount = resolveInviterReward(code, config);
  const now = new Date().toISOString();
  return settleRecord(
    current,
    { inviterState: 'paid', rewardAmount: amount, paidAt: now },
    amount > 0
      ? {
          userId: record.spec.inviterId,
          amount,
          currency: config.currency,
          referenceId: `${record.name}:inviter`,
          ledgerType: LEDGER_TYPE_INVITER,
          note: `推广奖励 ${record.spec.code}`,
        }
      : null,
  );
}

/** 发放被邀请人注册奖励；与触发档位无关，归因成立即发。 */
export async function awardInvitee(
  record: RecordInstance,
  config: ReferralConfig,
): Promise<'paid' | 'already-paid' | 'skipped'> {
  const current = await latestRecord(record);
  if (current.spec.inviteeState === 'paid') return 'already-paid';

  const amount = config.inviteeRewardAmount;
  return settleRecord(
    current,
    { inviteeState: 'paid', inviteeRewardAmount: amount },
    amount > 0
      ? {
          userId: record.spec.inviteeId,
          amount,
          currency: config.currency,
          referenceId: `${record.name}:invitee`,
          ledgerType: LEDGER_TYPE_INVITEE,
          note: '推广注册奖励',
        }
      : null,
  );
}

/** 标记归因记录被风控拒绝（不发任何奖励）。 */
export async function rejectRecord(record: RecordInstance, reason: string): Promise<void> {
  const pluginCtx = context();
  pluginCtx.logger.warn(`referral: 归因被拒绝 ${record.name} ${reason}`);
  await pluginCtx.extensions.update<ReferralRecord>(
    recordModel,
    record.name,
    { ...record.spec, inviterState: 'rejected' },
    { expectedVersion: record.version },
  );
}

/** 首单支付把 pending 记录推进为合格，并立即给推广人发奖。 */
export async function qualifyByOrder(
  record: RecordInstance,
  orderId: string,
  code: ReferralCode | null,
  config: ReferralConfig,
): Promise<void> {
  if (record.spec.inviterState !== 'pending') return;
  const qualified: RecordInstance = {
    ...record,
    spec: { ...record.spec, qualifiedOrderId: orderId, qualifiedAt: new Date().toISOString() },
  };
  // 先落订单标记再发奖（发奖会写 inviterState=paid，两者在同一事务里各自更新一版）。
  const pluginCtx = context();
  await pluginCtx.extensions.update<ReferralRecord>(recordModel, record.name, qualified.spec, {
    expectedVersion: record.version,
  });
  const latest = await pluginCtx.extensions.get<ReferralRecord>(recordModel, record.name);
  if (!latest) return;
  await awardInviter(latest, code, config);
}
