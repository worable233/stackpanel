/**
 * SP v1 upstream surface (owner: channel plugin; moved out of the kernel under
 * ADR-0021 §D4). Served as `kind: 'raw'` routes so the signature is verified
 * over the exact request bytes.
 *
 * It is the network-facing outlet of the platform's existing domain capabilities
 * (catalog / orders / services) for channel partners. Domain truth lives in the
 * commerce plugin and is reached through the `commerce.operations` outlet.
 *
 * Authentication is signature-based (Ed25519 over a canonical request string)
 * with a replay window, single-use nonce and per-partner RPM — all in shared
 * state so they hold across replicas. Writes additionally require
 * `Idempotency-Key`.
 */
import { z } from 'zod';
import type { RawHttpReply, RawHttpRequest } from '@stackpanel/sdk';
import { context } from './context';
import { authenticatePartner, problemReply, requirePartnerScope } from './guard';
import { runSpIdempotent } from './idempotency';
import { enqueueWebhook } from './webhook';
import {
  commerceOperations,
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
} from './mapping';
import type { PartnerRecord } from './repository';

/** Capability scopes a partner may be granted. */
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

const ACTION = z.enum(['suspend', 'resume', 'terminate']);

/** Write a JSON body and end the raw response. */
function json(reply: RawHttpReply, status: number, body: unknown): void {
  reply.header('content-type', 'application/json; charset=utf-8');
  reply.header('cache-control', 'no-store');
  reply.status(status);
  reply.end(JSON.stringify(body));
}

function bodyObject(bodyText: string): unknown {
  if (!bodyText) return undefined;
  try {
    return JSON.parse(bodyText);
  } catch {
    return Symbol.for('invalid-json');
  }
}

function queryOf(request: RawHttpRequest): Record<string, unknown> {
  return Object.fromEntries(request.query.entries());
}

/** Translate a domain mapping error into the stable problem contract. */
function mapError(reply: RawHttpReply, error: unknown): void {
  if (error instanceof MappingError) {
    problemReply(reply, error.status, error.code, error.message);
    return;
  }
  throw error;
}

/** Emit one append-only audit row for a `/sp/v1/*` call (best-effort, replay-safe). */
async function auditCall(
  request: RawHttpRequest,
  partner: PartnerRecord | null,
  status: number,
  method: string,
  rawBody: string | null,
): Promise<void> {
  const write = async (): Promise<void> => {
    await context()
      .auth.audit({
        action: 'sp_v1.call',
        resource: 'sp_v1',
        ...(partner ? { resourceId: partner.id } : {}),
        ...(request.ip ? { ip: request.ip } : {}),
        meta: {
          method,
          path: request.url,
          status,
          keyId: partner?.keyId ?? null,
          resellerName: partner?.name ?? null,
        },
      })
      .catch(() => undefined);
  };
  // Route the audit through the idempotency layer keyed by the Idempotency-Key
  // header so a retried write does not append a second row. Bodyless reads audit
  // directly.
  const idemHeader = request.headers['idempotency-key'];
  const idemRaw = Array.isArray(idemHeader) ? idemHeader[0] : idemHeader;
  if (
    partner &&
    rawBody &&
    rawBody.length > 0 &&
    typeof idemRaw === 'string' &&
    idemRaw.length >= 8
  ) {
    const sink = {
      status() {
        return sink;
      },
      header() {
        return sink;
      },
      write() {
        return true;
      },
      end() {
        /* swallow the idempotent cached-body re-send */
      },
    } as unknown as RawHttpReply;
    await runSpIdempotent(request, sink, partner.id, async () => {
      await write();
      return null;
    }).catch(() => undefined);
    return;
  }
  await write();
}

/** Sentinel: the handler already wrote the response (e.g. idempotent replay). */
const REPLIED = Symbol('sp-v1-replied');

/**
 * Common envelope: authenticate + enforce scope, run `fn`, render its JSON body
 * as 200. Mapping errors become problem responses; the call is audited either way.
 */
async function guarded(
  request: RawHttpRequest,
  reply: RawHttpReply,
  scope: string,
  fn: (partner: PartnerRecord, bodyText: string) => Promise<unknown>,
): Promise<void> {
  let status = 200;
  let partner: PartnerRecord | null = null;
  let rawBody: string | null = null;
  let ran = false;
  try {
    const authenticated = await authenticatePartner(request, reply);
    if (!authenticated.ok) {
      status = authenticated.status;
      return;
    }
    partner = authenticated.partner;
    rawBody = authenticated.bodyText;
    if (!(await requirePartnerScope(reply, partner, scope))) {
      status = 403;
      return;
    }
    try {
      const result = await fn(partner, authenticated.bodyText);
      ran = true;
      if (result !== REPLIED) json(reply, 200, result);
    } catch (error) {
      mapError(reply, error);
    }
  } finally {
    await auditCall(request, partner, ran ? 200 : status, request.method, rawBody);
  }
}

/* ------------------------------- catalog ------------------------------- */

export async function spCatalog(request: RawHttpRequest, reply: RawHttpReply): Promise<void> {
  await guarded(request, reply, SP_SCOPES.catalogRead, async () => {
    const parsed = catalogQuery.safeParse(queryOf(request));
    if (!parsed.success) throw new MappingError(422, 'validation.invalid', '请求参数无效');
    return listCatalog(commerceOperations(), parsed.data);
  });
}

export async function spCatalogItem(request: RawHttpRequest, reply: RawHttpReply): Promise<void> {
  await guarded(request, reply, SP_SCOPES.catalogRead, async () => ({
    item: await getCatalogItem(commerceOperations(), request.params['id'] ?? ''),
  }));
}

/* -------------------------------- order -------------------------------- */

export async function spOrdersList(request: RawHttpRequest, reply: RawHttpReply): Promise<void> {
  await guarded(request, reply, SP_SCOPES.orderRead, async (partner) => {
    const parsed = pageQuery.safeParse(queryOf(request));
    if (!parsed.success) throw new MappingError(422, 'validation.invalid', '请求参数无效');
    return listOrders(
      commerceOperations(),
      partner,
      parsed.data.page ?? 1,
      parsed.data.pageSize ?? 20,
    );
  });
}

export async function spOrderGet(request: RawHttpRequest, reply: RawHttpReply): Promise<void> {
  await guarded(request, reply, SP_SCOPES.orderRead, async (partner) =>
    getOrder(commerceOperations(), partner, request.params['id'] ?? ''),
  );
}

export async function spOrderCreate(request: RawHttpRequest, reply: RawHttpReply): Promise<void> {
  await guarded(request, reply, SP_SCOPES.orderWrite, async (partner, bodyText) => {
    const parsed = createOrderBody.safeParse(bodyObject(bodyText));
    if (!parsed.success) throw new MappingError(422, 'validation.invalid', '请求参数无效');
    await runSpIdempotent(request, reply, partner.id, async () => {
      const result = await createOrder(commerceOperations(), partner, parsed.data);
      await enqueueWebhook(partner, 'order.created', result).catch(() => null);
      return result;
    });
    return REPLIED;
  });
}

/* ------------------------------- service ------------------------------- */

export async function spServicesList(request: RawHttpRequest, reply: RawHttpReply): Promise<void> {
  await guarded(request, reply, SP_SCOPES.serviceRead, async (partner) =>
    listServices(commerceOperations(), partner),
  );
}

export async function spServiceGet(request: RawHttpRequest, reply: RawHttpReply): Promise<void> {
  await guarded(request, reply, SP_SCOPES.serviceRead, async (partner) =>
    getService(commerceOperations(), partner, request.params['id'] ?? ''),
  );
}

export async function spServiceAction(request: RawHttpRequest, reply: RawHttpReply): Promise<void> {
  await guarded(request, reply, SP_SCOPES.serviceWrite, async (partner) => {
    const action = ACTION.safeParse(request.params['action']);
    const id = request.params['id'] ?? '';
    if (!action.success || !id) throw new MappingError(422, 'validation.invalid', '请求参数无效');
    await runSpIdempotent(request, reply, partner.id, async () => {
      const result = await runServiceLifecycle(
        commerceOperations(),
        partner,
        id,
        action.data as ServiceLifecycleAction,
      );
      await enqueueWebhook(partner, `service.${action.data}`, {
        serviceId: id,
        action: action.data,
      }).catch(() => null);
      return result;
    });
    return REPLIED;
  });
}
