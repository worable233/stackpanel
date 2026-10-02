/**
 * SP v1 upstream surface (P3 / PLAN-open-platform §7).
 *
 * The network-facing outlet of the existing domain capabilities — catalog,
 * orders and service lifecycle — for channel partners (resellers). It is not a
 * second implementation (ADR-0001): the domain truth lives in the store plugin
 * and is reached through the `commerce` outlet; lifecycle actions delegate to
 * the registered {@link FulfillmentProvider} via that outlet.
 *
 * Authentication is signature-based (Ed25519 over a canonical request string,
 * {@link authenticateReseller}) with a replay window, single-use nonce and
 * per-reseller RPM — all in shared state so they hold across replicas. Writes
 * additionally require `Idempotency-Key`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CommerceOperations } from '@stackpanel/sdk';
import { EXTENSION_POINTS, PluginError } from '@stackpanel/sdk';
import { getPrisma } from '../plugins/prisma.ts';
import { headerUserAgent, writeAudit } from '../plugins/audit.ts';
import { authenticateReseller, captureSpRawBody, requireResellerScope } from '../reseller/guard.ts';
import { runSpIdempotent } from '../reseller/idempotency.ts';
import { enqueueWebhook } from '../reseller/webhook.ts';
import {
  createOrder,
  getCatalogItem,
  getOrder,
  getService,
  listCatalog,
  listOrders,
  listServices,
  runServiceLifecycle,
  MappingError,
  type ServiceLifecycleAction,
} from '../reseller/mapping.ts';

/** Capability scopes a reseller may be granted. */
export const SP_SCOPES = {
  catalogRead: 'catalog:read',
  orderRead: 'order:read',
  orderWrite: 'order:write',
  serviceRead: 'service:read',
  serviceWrite: 'service:write',
} as const;

const pageQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

const catalogQuery = pageQuery.extend({ categoryId: z.string().min(1).max(191).optional() });

const createOrderBody = z
  .object({
    productId: z.string().min(1).max(191),
    quantity: z.number().int().min(1).max(100).default(1),
    channelCode: z.string().min(1).max(64).optional(),
  })
  .strict();

const idParam = z.object({ id: z.string().min(1).max(191) });
const actionParam = z.object({
  id: z.string().min(1).max(191),
  action: z.enum(['suspend', 'resume', 'terminate']),
});

/** The authenticated reseller (guaranteed by the `guarded` preHandler). */
function resellerOf(request: FastifyRequest) {
  const reseller = request.reseller;
  if (!reseller) throw new PluginError('sp_v1.unauthenticated', 401, '渠道未认证');
  return reseller;
}

/** Authenticate + enforce scopes; short-circuits with a problem response. */
function guarded(...scopes: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const reseller = await authenticateReseller(request, reply);
    if (!reseller) return;
    for (const scope of scopes) {
      if (!(await requireResellerScope(request, reply, scope))) return;
    }
  };
}

/** Translate a domain mapping error into the kernel's stable problem contract. */
function fail(error: unknown): never {
  if (error instanceof MappingError) {
    throw new PluginError(error.code, error.status, error.message);
  }
  throw error;
}

export async function spV1Routes(app: FastifyInstance): Promise<void> {
  // Buffer the raw body inside this encapsulated scope so the signature is
  // verified over the exact signed bytes (and only for /sp/v1/*).
  app.addHook('preParsing', captureSpRawBody);

  // 调用审计（DEV-CONSOLE P4）：每条 `/sp/v1/*` 请求落一条 append-only 记录，供开发者
  // 控制台按渠道回看调用轨迹。best-effort：审计写失败不影响对外响应。
  app.addHook('onResponse', async (request, reply) => {
    const reseller = request.reseller;
    const userAgent = headerUserAgent(request);
    await writeAudit({
      action: 'sp_v1.call',
      resource: 'sp_v1',
      ...(reseller ? { resourceId: reseller.id } : {}),
      ...(request.ip ? { ip: request.ip } : {}),
      ...(userAgent ? { userAgent } : {}),
      meta: {
        method: request.method,
        path: request.url,
        status: reply.statusCode,
        keyId: reseller?.keyId ?? null,
        resellerName: reseller?.name ?? null,
      },
    }).catch(() => undefined);
  });

  const prisma = () => getPrisma();
  const commerce = (request: FastifyRequest): CommerceOperations => {
    const ops = request.server.pluginRuntime.getExtensions<CommerceOperations>(
      EXTENSION_POINTS.commerce,
    )[0];
    if (!ops) throw new PluginError('sp_v1.store_unavailable', 503, '商店能力不可用');
    return ops;
  };

  /* ------------------------------- catalog ------------------------------- */
  app.get('/sp/v1/catalog', { preHandler: guarded(SP_SCOPES.catalogRead) }, async (request, reply) => {
    const query = catalogQuery.safeParse(request.query);
    if (!query.success) throw new PluginError('validation.invalid', 422, '请求参数无效');
    reply.header('Cache-Control', 'no-store');
    return listCatalog(commerce(request), query.data);
  });

  app.get(
    '/sp/v1/catalog/:id',
    { preHandler: guarded(SP_SCOPES.catalogRead) },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      if (!params.success) throw new PluginError('validation.invalid', 422, '请求参数无效');
      reply.header('Cache-Control', 'no-store');
      try {
        return { item: await getCatalogItem(commerce(request), params.data.id) };
      } catch (error) {
        fail(error);
      }
    },
  );

  /* -------------------------------- order -------------------------------- */
  app.get('/sp/v1/orders', { preHandler: guarded(SP_SCOPES.orderRead) }, async (request, reply) => {
    const query = pageQuery.safeParse(request.query);
    if (!query.success) throw new PluginError('validation.invalid', 422, '请求参数无效');
    reply.header('Cache-Control', 'no-store');
    return listOrders(
      prisma(),
      commerce(request),
      resellerOf(request),
      query.data.page ?? 1,
      query.data.pageSize ?? 20,
    );
  });

  app.get(
    '/sp/v1/orders/:id',
    { preHandler: guarded(SP_SCOPES.orderRead) },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      if (!params.success) throw new PluginError('validation.invalid', 422, '请求参数无效');
      reply.header('Cache-Control', 'no-store');
      try {
        return await getOrder(prisma(), commerce(request), resellerOf(request), params.data.id);
      } catch (error) {
        fail(error);
      }
    },
  );

  app.post('/sp/v1/orders', { preHandler: guarded(SP_SCOPES.orderWrite) }, async (request, reply) => {
    const body = createOrderBody.safeParse(request.body);
    if (!body.success) throw new PluginError('validation.invalid', 422, '请求参数无效');
    const reseller = resellerOf(request);
    await runSpIdempotent(request, reply, reseller.id, async () => {
      try {
        const result = await createOrder(prisma(), commerce(request), reseller, body.data);
        await enqueueWebhook(prisma(), reseller, 'order.created', result).catch(() => null);
        return result;
      } catch (error) {
        fail(error);
      }
    });
  });

  /* ------------------------------- service ------------------------------- */
  app.get(
    '/sp/v1/services',
    { preHandler: guarded(SP_SCOPES.serviceRead) },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return listServices(prisma(), commerce(request), resellerOf(request));
    },
  );

  app.get(
    '/sp/v1/services/:id',
    { preHandler: guarded(SP_SCOPES.serviceRead) },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      if (!params.success) throw new PluginError('validation.invalid', 422, '请求参数无效');
      reply.header('Cache-Control', 'no-store');
      try {
        return await getService(prisma(), commerce(request), resellerOf(request), params.data.id);
      } catch (error) {
        fail(error);
      }
    },
  );

  app.post(
    '/sp/v1/services/:id/:action',
    { preHandler: guarded(SP_SCOPES.serviceWrite) },
    async (request, reply) => {
      const params = actionParam.safeParse(request.params);
      if (!params.success) throw new PluginError('validation.invalid', 422, '请求参数无效');
      const reseller = resellerOf(request);
      const action = params.data.action as ServiceLifecycleAction;
      await runSpIdempotent(request, reply, reseller.id, async () => {
        try {
          const result = await runServiceLifecycle(
            prisma(),
            commerce(request),
            reseller,
            params.data.id,
            action,
          );
          await enqueueWebhook(prisma(), reseller, `service.${action}`, {
            serviceId: params.data.id,
            action,
          }).catch(() => null);
          return result;
        } catch (error) {
          fail(error);
        }
      });
    },
  );
}
