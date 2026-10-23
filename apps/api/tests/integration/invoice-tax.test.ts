import { existsSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser } from '../auth-helpers.ts';

const dbAvailable = await checkDbAvailable();

/**
 * 发票税额计算（#10）。
 *
 * 审计指出文档把「发票税额计算」漏记成「税缺失」。发票插件**不在内核仓库**里
 * （源码在 StackPanel-plugins，安装产物落在被忽略的 `data/plugins/`），所以既
 * 没有单测也容易被误判为不存在。这里用真实 Postgres + 真实安装产物验收计算口径。
 *
 * 要锁住的不是「能算个数」，而是**计税基数**：
 *   应税金额 = 小计 − 折扣        ← 折后计税
 *   税额     = round(应税 × 税率%) ← 四舍五入到最小货币单位
 *   总额     = 应税 + 税额
 *
 * 若哪天改成「按原价计税」，用户会被多收税 —— 这正是这类公式最容易出的错。
 */
/**
 * 发票插件可能装在**另一个工作区**（它是运行时安装产物，不在本仓库源码里）。
 * 这里额外探测同级 worktree（`../StackPanel/data`），让本机演练环境也能跑这条
 * 验收；两处都没有时整组跳过，而不是误报失败。
 */
function resolveDataDir(): string | null {
  const candidates = [
    process.env['STACKPANEL_DATA_DIR'],
    path.join(process.cwd(), 'data'),
    path.resolve(process.cwd(), '..', 'StackPanel', 'data'),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'plugins', 'invoice', 'manifest.json'))) {
      return candidate;
    }
  }
  return null;
}

const installedDataDir = resolveDataDir();
const invoiceInstalled = installedDataDir !== null;

const INVOICE_TABLE = 'ext_invoice_invoice';

describe.skipIf(!dbAvailable || !invoiceInstalled)(
  'invoice tax computation (real DB, real installed plugin)',
  () => {
    let app: FastifyInstance;
    const adminEmail = `inv_admin_${Date.now()}@example.com`;
    const password = 'IntegrationPass123';
    let adminToken = '';
    const createdIds: string[] = [];

    beforeAll(async () => {
      if (installedDataDir) {
        process.env['STACKPANEL_DATA_DIR'] = installedDataDir;
      }
      app = buildApp();
      await app.ready();
      await app.pluginRuntime.activate('login');
      const admin = await createAdminUser(app, adminEmail, password);
      adminToken = admin.token;
      // 发票插件依赖 store；两者都要激活才能注册路由。
      for (const id of ['store', 'invoice']) {
        await app.pluginRuntime.activate(id).catch(() => undefined);
        await app.inject({
          method: 'PATCH',
          url: `/admin/plugins/${id}`,
          headers: { authorization: `Bearer ${adminToken}` },
          payload: { enabled: true },
        });
      }
    });

    afterAll(async () => {
      const prisma = getPrisma();
      for (const id of createdIds) {
        await prisma
          .$executeRawUnsafe(`DELETE FROM "${INVOICE_TABLE}" WHERE "id" = $1`, id)
          .catch(() => undefined);
      }
      await prisma.user.deleteMany({ where: { email: adminEmail } });
      await app.close();
    });

    async function createInvoice(payload: Record<string, unknown>): Promise<{
      status: number;
      body: Record<string, unknown>;
    }> {
      const res = await app.inject({
        method: 'POST',
        url: '/invoice/admin/invoices',
        headers: { authorization: `Bearer ${adminToken}` },
        payload,
      });
      const body = (res.json() ?? {}) as Record<string, unknown>;
      const invoice = body['invoice'] as { id?: string } | undefined;
      if (invoice?.id) createdIds.push(invoice.id);
      return { status: res.statusCode, body };
    }

    it('折后计税：小计 10000 − 折扣 1000，税率 10% → 税额 900，总额 9900', async () => {
      const { status, body } = await createInvoice({
        customerName: '测试客户',
        items: [{ description: '云服务器', quantity: 1, unitPrice: 10000 }],
        discount: 1000,
        taxRate: 10,
      });
      expect(status).toBe(200);
      const invoice = body['invoice'] as {
        subtotal: number;
        discount: number;
        taxAmount: number;
        taxRate: number;
        total: number;
      };
      expect(invoice.subtotal).toBe(10000);
      expect(invoice.discount).toBe(1000);
      expect(invoice.taxRate).toBe(10);
      // 关键：税额按 9000 算，不是按 10000 算（那会是 1000，多收 100）。
      expect(invoice.taxAmount).toBe(900);
      expect(invoice.total).toBe(9900);
    });

    it('无折扣时按小计税：小计 5000，税率 6% → 税额 300', async () => {
      const { status, body } = await createInvoice({
        customerName: '无折扣客户',
        items: [{ description: '域名', quantity: 2, unitPrice: 2500 }],
        taxRate: 6,
      });
      expect(status).toBe(200);
      const invoice = body['invoice'] as { subtotal: number; taxAmount: number; total: number };
      expect(invoice.subtotal).toBe(5000);
      expect(invoice.taxAmount).toBe(300);
      expect(invoice.total).toBe(5300);
    });

    it('税率为 0 时总额等于折后金额', async () => {
      const { status, body } = await createInvoice({
        customerName: '免税客户',
        items: [{ description: '服务', quantity: 1, unitPrice: 8800 }],
        discount: 800,
        taxRate: 0,
      });
      expect(status).toBe(200);
      const invoice = body['invoice'] as { taxAmount: number; total: number };
      expect(invoice.taxAmount).toBe(0);
      expect(invoice.total).toBe(8000);
    });

    it('折扣不会超过小计，税额不为负', async () => {
      const { status, body } = await createInvoice({
        customerName: '超额折扣客户',
        items: [{ description: '小额商品', quantity: 1, unitPrice: 1000 }],
        // 折扣大于小计：实现会钳到小计，应税为 0。
        discount: 999999,
        taxRate: 13,
      });
      expect(status).toBe(200);
      const invoice = body['invoice'] as {
        subtotal: number;
        discount: number;
        taxAmount: number;
        total: number;
      };
      expect(invoice.subtotal).toBe(1000);
      expect(invoice.discount).toBeLessThanOrEqual(invoice.subtotal);
      expect(invoice.taxAmount).toBeGreaterThanOrEqual(0);
      expect(invoice.total).toBeGreaterThanOrEqual(0);
    });

    it('税率上限被钳在 100%', async () => {
      const { status, body } = await createInvoice({
        customerName: '越界税率客户',
        items: [{ description: '服务', quantity: 1, unitPrice: 1000 }],
        taxRate: 500,
      });
      // 入参 schema 限 0–100，越界应被拒绝而不是算出一个荒谬的税。
      expect([200, 400]).toContain(status);
      if (status === 200) {
        const invoice = body['invoice'] as { taxRate: number };
        expect(invoice.taxRate).toBeLessThanOrEqual(100);
      }
    });
  },
);
