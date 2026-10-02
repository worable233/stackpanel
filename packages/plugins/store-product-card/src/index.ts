import { EXTENSION_POINTS, definePlugin, PluginError } from '@stackpanel/sdk';
import type {
  FulfillmentProvider,
  HttpReply,
  HttpRequest,
  ProductConfigField,
  ProductTypeProvider,
  ProvisionContext,
  ProvisionResult,
  ProviderServiceContext,
  ServiceDetail,
} from '@stackpanel/sdk';
import { ExtensionNotFound, ExtensionVersionConflict } from '@stackpanel/sdk';
import { z } from 'zod';
import { bindExtensions, CardError, clearExtensions, extensions, runTransaction } from './context.js';
import { cardCodeModel, type CardCodeData } from './data.js';

/**
 * 发卡/兑换码商品类型插件。
 *
 * 码池经 Extension 引擎（`ctx.extensions`）读写，插件不再接触裸 DB：付款后
 * provision 原子领取一张未使用卡密返回给用户；未配置码池时履约失败并提示。
 */

const configSchema = z
  .object({
    deliverFormat: z.enum(['card_pwd', 'plain_code', 'link']).optional(),
    validityDays: z.number().int().positive().optional(),
    prefix: z.string().max(32).optional(),
  })
  .passthrough();

const configFields: ProductConfigField[] = [
  {
    name: 'deliverFormat',
    label: '发货格式',
    type: 'select',
    options: [
      { label: '卡号+密码', value: 'card_pwd' },
      { label: '单码', value: 'plain_code' },
      { label: '链接', value: 'link' },
    ],
  },
  { name: 'validityDays', label: '有效期（天）', type: 'number', min: 1 },
  { name: 'prefix', label: '卡密前缀（可选）', type: 'text', maxLength: 32 },
];

/** 最多重试领取次数：并发领取时乐观锁冲突后重取下一张可用卡密。 */
const CLAIM_MAX_ATTEMPTS = 8;

const cardProvider: FulfillmentProvider = {
  id: 'store-product-card',
  name: '发卡（本平台）',
  fulfillmentTypes: ['card'],

  async provision(ctx: ProvisionContext): Promise<ProvisionResult> {
    for (let attempt = 0; attempt < CLAIM_MAX_ATTEMPTS; attempt += 1) {
      const page = await extensions().list<CardCodeData>(cardCodeModel, {
        where: { productId: { eq: ctx.productId }, status: { eq: 'AVAILABLE' } },
        orderBy: { field: 'createdAt' },
        page: 1,
        pageSize: 1,
      });
      const taken = page.items[0];
      if (!taken) {
        return {
          status: 'FAILED',
          message: '该商品暂无可用卡密，请联系客服补货',
        };
      }
      try {
        await extensions().update<CardCodeData>(
          cardCodeModel,
          taken.name,
          {
            ...taken.spec,
            status: 'USED',
            orderId: ctx.orderId,
            userId: ctx.userId,
            consumedAt: new Date().toISOString(),
          },
          { expectedVersion: taken.version },
        );
        return {
          status: 'ACTIVE',
          providerServiceId: null,
          credentials: { code: taken.spec.code },
          runtime: { status: 'ACTIVE' },
        };
      } catch (error) {
        // Lost the optimistic-lock race (another buyer claimed it) or the row
        // vanished: try the next available code.
        if (error instanceof ExtensionVersionConflict || error instanceof ExtensionNotFound) {
          continue;
        }
        throw error;
      }
    }
    return { status: 'FAILED', message: '卡密领取繁忙，请稍后重试' };
  },

  async getDetail(service: ProviderServiceContext): Promise<ServiceDetail> {
    let code: string | null = null;
    if (service.service.credentialsRef) {
      const stored = await service.secrets.get(service.service.credentialsRef).catch(() => null);
      if (stored) {
        try {
          code = ((JSON.parse(stored) as Record<string, unknown>).code as string) ?? null;
        } catch {
          code = null;
        }
      }
    }
    const fields: ServiceDetail['fields'] = [];
    if (code) {
      fields.push({ label: '卡密/兑换码', value: code, copyable: true });
    } else {
      fields.push({ label: '状态', value: '正常' });
    }
    return { title: '发卡', status: 'ACTIVE', fields };
  },
};

const productType: ProductTypeProvider = {
  ...cardProvider,
  label: '发卡',
  configFields,
  configSchema,
};

const listCodesSchema = z.object({ productId: z.string().min(1).max(191) });
const createCodesSchema = z.object({
  productId: z.string().min(1).max(191),
  codes: z.string().min(1).max(20000),
});
const deleteCodeSchema = z.object({ id: z.string().min(1).max(191) });

export const storeProductCardPlugin = definePlugin({
  manifest: {
    id: 'store-product-card',
    name: '发卡商品类型',
    version: '0.2.0',
    description: '发卡/兑换码商品类型：码池管理 + 付款发卡履约。',
    requires: ['store'],
    permissions: ['store-product-card.admin'],
    roleTemplates: [{ role: 'ADMIN', permissions: ['store-product-card.admin'] }],
  },
  customModels: [cardCodeModel],
  routes: [
    {
      method: 'GET',
      path: '/store-product-card/admin/codes/:productId',
      auth: 'admin',
      permission: 'store-product-card.admin',
      handler: handle(async (req: HttpRequest) => {
        const params = listCodesSchema.safeParse(req.params);
        if (!params.success) throw new CardError(400, '参数无效');
        const rows = await extensions().listAll<CardCodeData>(cardCodeModel, {
          where: { productId: { eq: params.data.productId } },
          orderBy: { field: 'createdAt', desc: true },
        });
        const codes = rows.slice(0, 500).map((row) => ({
          id: row.name,
          ...row.spec,
          createdAt: row.createdAt,
        }));
        return { codes };
      }),
    },
    {
      method: 'POST',
      path: '/store-product-card/admin/codes',
      auth: 'admin',
      permission: 'store-product-card.admin',
      handler: handle(async (req: HttpRequest, reply: HttpReply) => {
        const body = createCodesSchema.safeParse(req.body);
        if (!body.success) throw new CardError(400, '参数无效');
        const { productId, codes } = body.data;
        const list = codes
          .split(/[\r\n,]+/)
          .map((line) => line.trim())
          .filter(Boolean);
        if (list.length === 0) throw new CardError(400, '没有可导入的卡密');
        await runTransaction(async (tx) => {
          for (const code of list) {
            await tx.extensions.create<CardCodeData>(cardCodeModel, {
              productId,
              code,
              status: 'AVAILABLE',
            });
          }
        });
        return reply.code(201).send({ count: list.length });
      }),
    },
    {
      method: 'DELETE',
      path: '/store-product-card/admin/codes/:id',
      auth: 'admin',
      permission: 'store-product-card.admin',
      handler: handle(async (req: HttpRequest, reply: HttpReply) => {
        const params = deleteCodeSchema.safeParse(req.params);
        if (!params.success) throw new CardError(400, '参数无效');
        try {
          await extensions().delete(cardCodeModel, params.data.id);
        } catch (error) {
          if (error instanceof ExtensionNotFound) throw new CardError(404, '卡密不存在');
          throw error;
        }
        return reply.code(204).send();
      }),
    },
  ],
  onActivate: (ctx) => {
    bindExtensions(ctx.extensions, ctx.tx);
    ctx.registerExtension(EXTENSION_POINTS.productType, productType);
    ctx.registerExtension(EXTENSION_POINTS.fulfillmentProvider, cardProvider);
    ctx.logger.info('store-product-card: activated (extension engine)');
  },
  onDeactivate: (ctx) => {
    clearExtensions();
    ctx.logger.info('store-product-card: deactivated');
  },
});

function handle(handler: (req: HttpRequest, reply: HttpReply) => Promise<unknown>) {
  return async (req: HttpRequest, reply: HttpReply): Promise<unknown> => {
    try {
      return await handler(req, reply);
    } catch (error) {
      if (error instanceof CardError) {
        throw new PluginError(error.code, error.status, error.message);
      }
      throw error;
    }
  };
}

export default storeProductCardPlugin;
