import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { configureOutboxEventBus, startOutboxConsumption } from '../../src/plugins/events.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser, createTestUser } from '../auth-helpers.ts';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { env } from '../../src/config/env.ts';

const dbAvailable = await checkDbAvailable();

/**
 * Both plugins come from the separate `stackpanel-plugins` repository, so they
 * exist only in a data directory that had them installed. A CI runner has
 * neither. Probe explicitly: skipping is honest, while failing on
 * `relation "ext_referral_record" does not exist` reads like a schema bug.
 */
const pluginsInstalled = ['referral', 'store'].every((id) =>
  existsSync(
    path.join(
      env.STACKPANEL_DATA_DIR ?? path.join(process.cwd(), 'data'),
      'plugins',
      id,
      'manifest.json',
    ),
  ),
);

/**
 * 推广返佣的**退款追回**（#11「退款追回」）。
 *
 * 这一条单独做成集成用例，是因为它的正确性不在「能不能扣钱」，而在三个只有
 * 真实事件链路才暴露的边界：
 *
 *  1. **事件接线**：`order.refunded` 必须真的被 store 发布、被 referral 收到。
 *     单测里我们直接调 `clawbackByRefund`，接线断了也照样绿 —— 这正是这类
 *     「两插件协作」缺陷最容易漏掉的地方。
 *  2. **整单 vs 部分退款**：只有 `full === true` 才追回。为此 store 的退款事件
 *     新增了 `full` 字段；如果哪天这个字段丢了，追回会静默失效。
 *  3. **账本幂等键**：扣回必须用独立 referenceId。复用入账那一笔会让
 *     `(referenceType, referenceId)` 撞唯一索引，被当成「已入账」而静默跳过。
 *
 * 真实 Postgres + 真实运行时安装产物（`data/plugins/referral`、`data/plugins/store`）。
 */
const RECORD_TABLE = 'ext_referral_record';
const ORDER_TABLE = 'ext_store_order';

/** 等异步事件落地：监听器是 `void handler()`，发布方不 await。 */
async function waitFor(check: () => Promise<boolean>, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

describe.skipIf(!dbAvailable || !pluginsInstalled)(
  'referral clawback on order refund (real DB)',
  () => {
    let app: FastifyInstance;
    const suffix = Date.now();
    const adminEmail = `cb_admin_${suffix}@example.com`;
    const inviterEmail = `cb_inviter_${suffix}@example.com`;
    const inviteeEmail = `cb_invitee_${suffix}@example.com`;
    const password = 'IntegrationPass123';
    let adminToken = '';
    let inviterId = '';
    let inviteeId = '';
    const userIds: string[] = [];
    const orderIds: string[] = [];

    /** 直接在扩展表里造一条「已发奖」的归因记录（省掉完整注册归因链路）。 */
    async function seedPaidRecord(input: {
      inviteeId: string;
      inviterId: string;
      qualifiedOrderId: string;
      rewardAmount: number;
      inviterState?: string;
    }): Promise<void> {
      const spec = {
        code: 'CLAWBACK1',
        inviterId: input.inviterId,
        inviteeId: input.inviteeId,
        inviteeEmail: inviteeEmail,
        trigger: 'first_order',
        inviterState: input.inviterState ?? 'paid',
        inviteeState: 'paid',
        freezeUntil: 0,
        rewardAmount: input.rewardAmount,
        inviteeRewardAmount: 0,
        registerIp: '10.0.0.1',
        qualifiedOrderId: input.qualifiedOrderId,
        qualifiedAt: new Date().toISOString(),
        paidAt: new Date().toISOString(),
        clawedBackAtMs: 0,
        clawedBackAmount: 0,
        clawedBackOrderId: null,
      };
      await getPrisma().$executeRawUnsafe(
        `INSERT INTO "${RECORD_TABLE}"
         ("id", "owner_id", "version", "spec", "status", "labels", "annotations", "finalizers",
          "created_at", "updated_at", "f_inviteeId", "f_inviterId", "f_inviterState", "f_registerIp", "f_freezeUntil")
       VALUES ($1, NULL, 1, $2::jsonb, NULL, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb,
               now(), now(), $3, $4, $5, $6, $7)`,
        input.inviteeId,
        JSON.stringify(spec),
        input.inviteeId,
        input.inviterId,
        input.inviterState ?? 'paid',
        '10.0.0.1',
        0,
      );
    }

    async function seedPaidOrder(input: {
      userId: string;
      settlementTotal: number;
    }): Promise<string> {
      const id = `order_cb_${Math.random().toString(36).slice(2, 10)}`;
      const spec = {
        userId: input.userId,
        items: { items: [{ productId: 'p', quantity: 1 }] },
        total: input.settlementTotal,
        currency: 'CNY',
        state: 'PAID',
        channelCode: null,
        settlementCurrency: 'CNY',
        settlementTotal: input.settlementTotal,
        fxRate: null,
      };
      await getPrisma().$executeRawUnsafe(
        `INSERT INTO "${ORDER_TABLE}"
         ("id", "owner_id", "version", "spec", "status", "labels", "annotations", "finalizers",
          "created_at", "updated_at", "f_userId", "f_state")
       VALUES ($1, NULL, 1, $2::jsonb, NULL, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb,
               now(), now(), $3, $4)`,
        id,
        JSON.stringify(spec),
        input.userId,
        'PAID',
      );
      orderIds.push(id);
      return id;
    }

    /** 给推广人账上放钱，`debit` 才能成功。 */
    async function seedBalance(userId: string, balance: number): Promise<void> {
      await getPrisma().walletAccount.upsert({
        where: { userId_currency: { userId, currency: 'CNY' } },
        create: { userId, currency: 'CNY', balance },
        update: { balance },
      });
    }

    async function readRecord(inviteeId: string): Promise<Record<string, unknown> | null> {
      const rows = await getPrisma().$queryRawUnsafe<Array<{ spec: Record<string, unknown> }>>(
        `SELECT "spec" FROM "${RECORD_TABLE}" WHERE "id" = $1`,
        inviteeId,
      );
      return rows[0]?.spec ?? null;
    }

    async function readBalance(userId: string): Promise<number> {
      const account = await getPrisma().walletAccount.findUnique({
        where: { userId_currency: { userId, currency: 'CNY' } },
      });
      return account?.balance ?? 0;
    }

    beforeAll(async () => {
      app = buildApp();
      await app.ready();
      await app.pluginRuntime.activate('login');
      const admin = await createAdminUser(app, adminEmail, password);
      const inviter = await createTestUser(app, inviterEmail, password);
      const invitee = await createTestUser(app, inviteeEmail, password);
      adminToken = admin.token;
      inviterId = inviter.userId;
      inviteeId = invitee.userId;
      userIds.push(admin.userId, inviter.userId, invitee.userId);

      for (const id of ['store', 'referral']) {
        await getPrisma().plugin.deleteMany({ where: { id } });
        const enable = await app.inject({
          method: 'PATCH',
          url: `/admin/plugins/${id}`,
          headers: { authorization: `Bearer ${adminToken}` },
          payload: { enabled: true },
        });
        expect(enable.statusCode).toBe(200);
      }

      // 测试进程不走 `initInfra()`，因此 outbox 默认是「未绑定的进程内总线」：
      // `ctx.tx().publish` 写进 outbox 行，却没有 relay 去投递 —— 跨插件的
      // `order.refunded` 永远不会到达 referral。这里按生产路径显式绑定并发起
      // 消费，否则这条用例会以「什么都没发生」的方式假失败。
      // 顺序要紧：subscription 已在 `activate` 时注册，再启动消费游标，
      // 避免游标先推进过事件（审计 4B · B-1）。
      configureOutboxEventBus({
        db: getPrisma() as unknown as Parameters<typeof configureOutboxEventBus>[0]['db'],
        redis: null,
        production: false,
        catchUpIntervalMs: 50,
      });
      startOutboxConsumption();

      // 打开推广并给推广人 500 分奖励额度（触发档位必须是 first_order，追回才有意义）。
      const config = await app.inject({
        method: 'POST',
        url: '/store/admin/referrals/config',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          enabled: true,
          trigger: 'first_order',
          rewardAmount: 500,
          inviteeRewardAmount: 0,
          freezeDays: 0,
          cookieDays: 30,
          maxInvitesPerUser: 0,
          sameIpLimit: 0,
          currency: 'CNY',
        },
      });
      expect(config.statusCode).toBe(200);
    });

    afterAll(async () => {
      const prisma = getPrisma();
      await prisma.$executeRawUnsafe(
        `DELETE FROM "${RECORD_TABLE}" WHERE "f_inviteeId" = $1`,
        inviteeId,
      );
      for (const id of orderIds) {
        await prisma.$executeRawUnsafe(`DELETE FROM "${ORDER_TABLE}" WHERE "id" = $1`, id);
      }
      await prisma.walletLedgerEntry.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.walletAccount.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      for (const id of ['store', 'referral']) {
        await prisma.plugin.deleteMany({ where: { id } });
      }
      await app.close();
    });

    it('整单退款：store 发布 order.refunded，referral 扣回奖励并标记 clawed_back', async () => {
      const orderId = await seedPaidOrder({ userId: inviteeId, settlementTotal: 10000 });
      await seedPaidRecord({
        inviteeId,
        inviterId,
        qualifiedOrderId: orderId,
        rewardAmount: 500,
      });
      await seedBalance(inviterId, 500);

      const res = await app.inject({
        method: 'POST',
        url: `/store/admin/orders/${orderId}/refund`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(200);

      const settled = await waitFor(async () => {
        const record = await readRecord(inviteeId);
        return record?.['inviterState'] === 'clawed_back';
      });
      expect(settled).toBe(true);

      const record = await readRecord(inviteeId);
      expect(record?.['inviterState']).toBe('clawed_back');
      expect(record?.['clawedBackAmount']).toBe(500);
      expect(record?.['clawedBackOrderId']).toBe(orderId);
      // 钱真的被扣走了，而不只是状态变了。
      expect(await readBalance(inviterId)).toBe(0);

      const clawbackEntry = await getPrisma().walletLedgerEntry.findFirst({
        where: { userId: inviterId, referenceType: 'REFERRAL' },
        orderBy: { createdAt: 'desc' },
      });
      expect(clawbackEntry?.amount).toBe(-500);
      // 独立幂等键：复用入账那笔会被唯一索引当成「已入账」而静默跳过。
      expect(clawbackEntry?.referenceId).toBe(`${inviteeId}:inviter:clawback`);
    });

    it('余额已被花掉：退款仍然成功，记录标 clawed_back 但追回金额记 0', async () => {
      const orderId = await seedPaidOrder({ userId: inviteeId, settlementTotal: 20000 });
      // 覆盖上一条记录，换成本单的归因。
      await getPrisma().$executeRawUnsafe(
        `DELETE FROM "${RECORD_TABLE}" WHERE "f_inviteeId" = $1`,
        inviteeId,
      );
      await seedPaidRecord({
        inviteeId,
        inviterId,
        qualifiedOrderId: orderId,
        rewardAmount: 800,
      });
      // 推广人账上没钱：debit 会抛 409。
      await seedBalance(inviterId, 0);

      const res = await app.inject({
        method: 'POST',
        url: `/store/admin/orders/${orderId}/refund`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {},
      });
      // 退款是商店对买家的承诺，不能因为平台与推广人之间的账而失败。
      expect(res.statusCode).toBe(200);

      const settled = await waitFor(async () => {
        const record = await readRecord(inviteeId);
        return record?.['inviterState'] === 'clawed_back';
      });
      expect(settled).toBe(true);

      const record = await readRecord(inviteeId);
      expect(record?.['inviterState']).toBe('clawed_back');
      // 状态表示「应当追回」，金额表示「真正追回了多少」—— 账面不说谎。
      expect(record?.['clawedBackAmount']).toBe(0);
      expect(record?.['clawedBackOrderId']).toBe(orderId);
    });

    it('部分退款：不追回（只处理整单撤销）', async () => {
      const orderId = await seedPaidOrder({ userId: inviteeId, settlementTotal: 10000 });
      await getPrisma().$executeRawUnsafe(
        `DELETE FROM "${RECORD_TABLE}" WHERE "f_inviteeId" = $1`,
        inviteeId,
      );
      await seedPaidRecord({
        inviteeId,
        inviterId,
        qualifiedOrderId: orderId,
        rewardAmount: 500,
      });
      await seedBalance(inviterId, 500);

      const res = await app.inject({
        method: 'POST',
        url: `/store/admin/orders/${orderId}/refund`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { amount: 3_000 },
      });
      expect(res.statusCode).toBe(200);

      // 给事件一点时间；它本就不该触发追回。
      await new Promise((resolve) => setTimeout(resolve, 300));
      const record = await readRecord(inviteeId);
      expect(record?.['inviterState']).toBe('paid');
      expect(record?.['clawedBackAmount']).toBe(0);
      expect(await readBalance(inviterId)).toBe(500);
    });

    it('归因订单不匹配：别的订单退款不追回这条奖励', async () => {
      const qualifiedOrderId = await seedPaidOrder({ userId: inviteeId, settlementTotal: 10000 });
      const otherOrderId = await seedPaidOrder({ userId: inviteeId, settlementTotal: 5000 });
      await getPrisma().$executeRawUnsafe(
        `DELETE FROM "${RECORD_TABLE}" WHERE "f_inviteeId" = $1`,
        inviteeId,
      );
      await seedPaidRecord({
        inviteeId,
        inviterId,
        qualifiedOrderId,
        rewardAmount: 500,
      });
      await seedBalance(inviterId, 500);

      const res = await app.inject({
        method: 'POST',
        url: `/store/admin/orders/${otherOrderId}/refund`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(200);

      await new Promise((resolve) => setTimeout(resolve, 300));
      const record = await readRecord(inviteeId);
      expect(record?.['inviterState']).toBe('paid');
      expect(await readBalance(inviterId)).toBe(500);
    });
  },
);
