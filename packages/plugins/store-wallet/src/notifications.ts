import { formatMinorCurrency } from '@stackpanel/sdk';
import { context } from './context';

/**
 * 管理员调余额的回执（best-effort）。
 *
 * 类型 `wallet.balance.adjusted` 由**内核内建目录**声明（内核的
 * `/admin/users/:id/wallet` 与开放 API 也发同一类型），因此插件不再重复声明，
 * 避免同一类型出现两个目录项。
 *
 * 余额被改动对用户是「钱」的事实。不设 `dedupeKey`（每次调整都是独立账务事实），
 * 失败只告警，绝不回滚已经入账的调整。
 */
export async function notifyBalanceAdjusted(input: {
  userId: string;
  amount: number;
  currency: string;
  note: string;
  balance: number;
}): Promise<void> {
  if (input.amount === 0) return;
  try {
    await context().notifications.create({
      userId: input.userId,
      type: 'wallet.balance.adjusted',
      title: input.amount > 0 ? '余额已增加' : '余额已扣减',
      body: `管理员${input.amount > 0 ? '增加' : '扣减'}了你的钱包余额 ${formatMinorCurrency(
        Math.abs(input.amount),
        input.currency,
        'zh-CN',
      )}${input.note ? `（备注：${input.note}）` : ''}。当前余额 ${formatMinorCurrency(
        input.balance,
        input.currency,
        'zh-CN',
      )}。`,
      link: '/account/balance',
      data: {
        amount: input.amount,
        currency: input.currency,
        note: input.note,
        balance: input.balance,
      },
      status: 'info',
    });
  } catch (error) {
    context().logger.warn(
      `store-wallet: balance notification failed for ${input.userId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
