import type { HttpReply, HttpRequest } from '@stackpanel/sdk';
import { PaymentError, PluginError, WalletError, definePlugin } from '@stackpanel/sdk';
import { z } from 'zod';
import { bindContext, context, resetContext } from './context';
import { WalletPluginError } from './errors';

const CURRENCY = 'CNY';

const topUpSchema = z.object({
  amount: z.number().int().min(100).max(2_000_000_000),
  providerId: z.string().max(64),
  paymentMethod: z.string().max(64),
});

const idSchema = z.object({ id: z.string().max(191) });

const adjustmentSchema = z.object({
  email: z.string().email().max(191),
  amount: z.number().int().min(-2_000_000_000).max(2_000_000_000),
  note: z.string().max(191),
});

function handle(handler: (req: HttpRequest, reply: HttpReply) => Promise<unknown>) {
  return async (req: HttpRequest, reply: HttpReply): Promise<unknown> => {
    try {
      return await handler(req, reply);
    } catch (error) {
      if (
        error instanceof WalletPluginError ||
        error instanceof PaymentError ||
        error instanceof WalletError
      ) {
        throw new PluginError(error.code, error.status, error.message);
      }
      throw error;
    }
  };
}

const getWallet = async (req: HttpRequest): Promise<unknown> => {
  const userId = req.user?.id ?? '';
  const wallet = context().wallet;
  const payments = context().payments;
  const [account, entries, topUps, methods] = await Promise.all([
    wallet.getAccount(userId),
    wallet.listLedger(userId, 50),
    payments.listTopUps(userId, 50),
    payments.listPaymentMethods(),
  ]);
  return {
    account: account ?? { userId, currency: CURRENCY, balance: 0 },
    entries,
    topUps,
    providers: methods.providers,
  };
};

const createTopUp = async (req: HttpRequest): Promise<unknown> => {
  const parsed = topUpSchema.safeParse(req.body);
  if (!parsed.success) throw new WalletPluginError(400, '无效的充值参数');
  const input = parsed.data;
  const created = await context().payments.create({
    purpose: 'TOP_UP',
    userId: req.user?.id ?? '',
    amount: input.amount,
    currency: CURRENCY,
    providerId: input.providerId,
    paymentMethod: input.paymentMethod,
    subject: '钱包充值',
    returnPath: '/account/balance',
    ...(req.ip ? { clientIp: req.ip } : {}),
  });
  return {
    topUp: {
      id: created.id,
      amount: created.amount,
      currency: created.currency,
      providerId: created.providerId,
      paymentMethod: created.paymentMethod,
      paymentUrl: created.paymentUrl,
      status: created.status,
      createdAt: created.createdAt,
    },
  };
};

const cancelTopUp = async (req: HttpRequest): Promise<unknown> => {
  const parsed = idSchema.safeParse(req.params);
  if (!parsed.success) throw new WalletPluginError(400, '无效的参数');
  return context().payments.cancelTopUp(parsed.data.id, req.user?.id ?? '');
};

const listAdminWallets = async (): Promise<unknown> => ({
  accounts: await context().wallet.listAccounts(50),
});

const adjustWallet = async (req: HttpRequest): Promise<unknown> => {
  const parsed = adjustmentSchema.safeParse(req.body);
  if (!parsed.success) throw new WalletPluginError(400, '无效的调整参数');
  const input = parsed.data;
  const user = await context().auth.getUserByEmail(input.email);
  if (!user) throw new WalletPluginError(404, '用户不存在');
  await context().wallet.adjust({
    userId: user.id,
    amount: input.amount,
    currency: CURRENCY,
    note: input.note,
    ...(req.user?.id ? { actorId: req.user.id } : {}),
  });
  return { ok: true };
};

export const storeWalletPlugin = definePlugin({
  manifest: {
    id: 'store-wallet',
    name: '钱包插件',
    version: '0.1.0',
    description: '余额、充值与管理。',
    requires: [{ id: 'store', range: '^0.3.0' }],
    permissions: ['store.wallet', 'store.admin'],
    roleTemplates: [
      { role: 'USER', permissions: ['store.wallet'] },
      { role: 'ADMIN', permissions: ['store.admin'] },
    ],
  },
  routes: [
    {
      method: 'GET',
      path: '/wallet',
      auth: 'user',
      permission: 'store.wallet',
      handler: handle(getWallet),
    },
    {
      method: 'POST',
      path: '/wallet/topups',
      auth: 'user',
      permission: 'store.wallet',
      handler: handle(createTopUp),
    },
    {
      method: 'POST',
      path: '/wallet/topups/:id/cancel',
      auth: 'user',
      permission: 'store.wallet',
      handler: handle(cancelTopUp),
    },
    {
      method: 'GET',
      path: '/store/admin/wallets',
      auth: 'admin',
      permission: 'store.admin',
      handler: handle(listAdminWallets),
    },
    {
      method: 'POST',
      path: '/store/admin/wallets/adjustments',
      auth: 'admin',
      permission: 'store.admin',
      handler: handle(adjustWallet),
    },
  ],
  onActivate: (ctx) => {
    bindContext(ctx);
    ctx.logger.info('store-wallet: activated');
  },
  onDeactivate: (ctx) => {
    resetContext();
    ctx.logger.info('store-wallet: deactivated');
  },
});

export default storeWalletPlugin;