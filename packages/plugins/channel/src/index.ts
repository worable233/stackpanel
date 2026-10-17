import type { HttpReply, HttpRequest } from '@stackpanel/sdk';
import { definePlugin, PluginError } from '@stackpanel/sdk';
import { bindContext, resetContext } from './context';
import { ChannelError } from './errors';
import { deliveryModel, partnerModel } from './data';
import { ChannelRepository } from './repository';
import {
  createPartner,
  deletePartner,
  developerOverview,
  getPartner,
  listCalls,
  listDeliveries,
  listPartners,
  rotatePartnerKey,
  updatePartner,
} from './developer';
import {
  spCatalog,
  spCatalogItem,
  spOrderCreate,
  spOrderGet,
  spOrdersList,
  spServiceAction,
  spServiceGet,
  spServicesList,
} from './sp-v1';
import { enqueueWebhook, processDueWebhooks, WEBHOOK_JOBS } from './webhook';

const WEBHOOK_POLL_MS = 5_000;

/** Wrap a handler so a deterministic ChannelError becomes a problem+json reply. */
function handle(handler: (req: HttpRequest, reply: HttpReply) => Promise<unknown>) {
  return async (req: HttpRequest, reply: HttpReply): Promise<unknown> => {
    try {
      return await handler(req, reply);
    } catch (error) {
      if (error instanceof ChannelError) {
        throw new PluginError(error.code, error.status, error.message);
      }
      throw error;
    }
  };
}

interface OrderPaidEvent {
  orderId: string;
  channelCode?: string | null;
  status?: string;
  total?: number;
  currency?: string;
}

/**
 * Fan a store `order.paid` event out to the originating partner as a signed
 * webhook. The channel code carries `SP_V1:<keyId>[:ref]`.
 */
async function notifyPartnerOfOrder(event: OrderPaidEvent): Promise<void> {
  const channelCode = event.channelCode;
  if (!channelCode || !channelCode.startsWith('SP_V1:')) return;
  const keyId = channelCode.split(':')[1];
  if (!keyId) return;
  const partner = await new ChannelRepository().findByKeyId(keyId);
  if (!partner) return;
  await enqueueWebhook(partner, 'order.paid', {
    orderId: event.orderId,
    status: event.status ?? 'PAID',
    total: event.total ?? 0,
    currency: event.currency ?? 'CNY',
  });
}

export const channelPlugin = definePlugin({
  manifest: {
    id: 'channel',
    name: '渠道插件',
    version: '0.1.0',
    description: '渠道伙伴、签名开放 API 与出站回调。',
    permissions: [
      { key: 'channel.partner', name: '浏览渠道伙伴', description: '查看渠道伙伴列表与详情。' },
      {
        key: 'channel.manage',
        name: '管理渠道伙伴',
        description: '创建、修改、轮换与删除渠道伙伴。',
        scope: 'channel',
      },
      {
        key: 'channel.sp.write',
        name: '渠道下单/生命周期',
        description: '通过 SP v1 为渠道伙伴下单并执行交付物生命周期动作。',
      },
      {
        key: 'channel.sp.read',
        name: '渠道读取',
        description: '读取渠道目录、订单与交付物。',
      },
    ],
    roleTemplates: [{ role: 'ADMIN', permissions: ['channel.manage', 'channel.partner'] }],
  },

  customModels: [partnerModel, deliveryModel],

  routes: [
    /* ------------------------- 渠道伙伴（管理端） ------------------------- */
    {
      method: 'GET',
      path: '/admin/developer/overview',
      auth: 'admin',
      handler: handle(developerOverview),
    },
    {
      method: 'GET',
      path: '/admin/developer/resellers',
      auth: 'admin',
      handler: handle(listPartners),
    },
    {
      method: 'GET',
      path: '/admin/developer/resellers/:id',
      auth: 'admin',
      handler: handle(getPartner),
    },
    {
      method: 'GET',
      path: '/admin/developer/webhook-deliveries',
      auth: 'admin',
      handler: handle(listDeliveries),
    },
    { method: 'GET', path: '/admin/developer/calls', auth: 'admin', handler: handle(listCalls) },
    {
      method: 'POST',
      path: '/admin/developer/resellers',
      auth: 'admin',
      handler: handle(createPartner),
    },
    {
      method: 'PATCH',
      path: '/admin/developer/resellers/:id',
      auth: 'admin',
      handler: handle(updatePartner),
    },
    {
      method: 'POST',
      path: '/admin/developer/resellers/:id/rotate-key',
      auth: 'admin',
      handler: handle(rotatePartnerKey),
    },
    {
      method: 'DELETE',
      path: '/admin/developer/resellers/:id',
      auth: 'admin',
      handler: handle(deletePartner),
    },

    /* ------------------------ SP v1（签名 raw 入口） ------------------------ */
    { method: 'GET', path: '/sp/v1/catalog', kind: 'raw', auth: 'public', handler: spCatalog },
    {
      method: 'GET',
      path: '/sp/v1/catalog/:id',
      kind: 'raw',
      auth: 'public',
      handler: spCatalogItem,
    },
    { method: 'GET', path: '/sp/v1/orders', kind: 'raw', auth: 'public', handler: spOrdersList },
    { method: 'GET', path: '/sp/v1/orders/:id', kind: 'raw', auth: 'public', handler: spOrderGet },
    { method: 'POST', path: '/sp/v1/orders', kind: 'raw', auth: 'public', handler: spOrderCreate },
    {
      method: 'GET',
      path: '/sp/v1/services',
      kind: 'raw',
      auth: 'public',
      handler: spServicesList,
    },
    {
      method: 'GET',
      path: '/sp/v1/services/:id',
      kind: 'raw',
      auth: 'public',
      handler: spServiceGet,
    },
    {
      method: 'POST',
      path: '/sp/v1/services/:id/:action',
      kind: 'raw',
      auth: 'public',
      handler: spServiceAction,
    },
  ],

  onActivate: (ctx) => {
    ctx.effect(() => {
      bindContext(ctx);
      return resetContext;
    });

    // store `order.paid` → 渠道签名回调。可逆订阅。
    ctx.effect(() =>
      ctx.events.subscribe('order.paid', (payload, meta) => {
        const event = payload as OrderPaidEvent | null;
        if (!event?.orderId) return;
        const notify = () => notifyPartnerOfOrder(event);
        // at-least-once 投递（relay 重投 / 离线 catch-up）→ 按 eventId 去重，
        // 保证同一事件只为同一伙伴生成一条回调投递记录。
        const run =
          meta?.eventId && typeof ctx.events.runIdempotent === 'function'
            ? ctx.events.runIdempotent('channel.order-paid', meta.eventId, notify)
            : notify();
        void Promise.resolve(run).catch(() => undefined);
      }),
    );

    // at-least-once 回调派发：集群下单次执行。
    ctx.jobs.handle(WEBHOOK_JOBS.deliver, async () => {
      await processDueWebhooks();
    });
    ctx.jobs.schedule(WEBHOOK_JOBS.deliver, { everyMs: WEBHOOK_POLL_MS });

    ctx.logger.info('channel: activated');
  },
  onDeactivate: (ctx) => {
    ctx.logger.info('channel: deactivated');
  },
});

export default channelPlugin;
