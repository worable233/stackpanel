/**
 * SP v1 签名 webhook 派发（P3）。
 *
 * 生命周期事件（order.provisioned / service.suspended 等）通过签名回调推送给
 * 渠道伙伴。投递采用 at-least-once：先落 `webhook_deliveries`（PENDING），再由
 * 内核周期任务认领并 POST；成功标记 SUCCEEDED，失败按退避重试，超过上限标记 FAILED。
 *
 * 回调体带 Ed25519 签名，复用与入站请求一致的规范化串（nonce 用投递 id），
 * 伙伴侧按同一算法验签即可防伪造。投递 id 亦作为幂等键，伙伴可据此去重。
 */
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { PrismaClient } from '@stackpanel/db';
import { isPublicHttpUrl, resolvesToUnsafeAddress } from '@stackpanel/net-guard';
import { bodyDigest, canonicalRequest, signCanonical } from './signing.ts';
import { revealPrivateKey } from './keys.ts';
import { ResellerRepository, type ResellerRecord, type WebhookDeliveryRecord } from './repository.ts';

export const WEBHOOK_JOBS = { deliver: 'webhook-deliver' } as const;

const DEFAULT_MAX_ATTEMPTS = 6;
const REQUEST_TIMEOUT_MS = 10_000;

/** Fetch using the address that was checked for SSRF, preserving Host/SNI. */
async function pinnedFetch(urlValue: string, init: RequestInit): Promise<Response> {
  const url = new URL(urlValue);
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error('回调地址无法解析');
  const address = addresses[0]?.address;
  if (!address) throw new Error('回调地址无法解析');
  const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = requestFn({
      protocol: url.protocol,
      hostname: address,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: init.method ?? 'GET',
      headers: { ...(init.headers as Record<string, string> | undefined), host: url.host },
      ...(url.protocol === 'https:' ? { servername: url.hostname } : {}),
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), {
        status: res.statusCode ?? 502,
        headers: Object.fromEntries(Object.entries(res.headers).flatMap(([key, value]) =>
          typeof value === 'string' ? [[key, value]] : value ? [[key, value.join(', ')]] : [],
        )),
      })));
      res.on('error', reject);
    });
    const timer = setTimeout(() => req.destroy(new Error('请求超时')), REQUEST_TIMEOUT_MS);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    if (init.body !== undefined && init.body !== null) req.write(String(init.body));
    req.end();
  });
}
/** Deterministic backoff (attempt n → n × 30s), capped. */
function backoffMs(attempts: number): number {
  return Math.min(Math.max(1, attempts), 6) * 30_000;
}

export interface WebhookEnvelope {
  id: string;
  event: string;
  createdAt: string;
  data: unknown;
}

/**
 * Persist a webhook delivery and nudge the dispatcher. Returns null when the
 * reseller has no callback URL configured (nothing to deliver).
 */
export async function enqueueWebhook(
  prisma: PrismaClient,
  reseller: ResellerRecord,
  event: string,
  data: unknown,
): Promise<string | null> {
  if (!reseller.webhookUrl) return null;
  const repo = new ResellerRepository(prisma);
  const id = `wh_${randomUUID()}`;
  const envelope: WebhookEnvelope = {
    id,
    event,
    createdAt: new Date().toISOString(),
    data,
  };
  await repo.createDelivery({
    id,
    resellerId: reseller.id,
    event,
    url: reseller.webhookUrl,
    payload: envelope,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
  });
  void processDueWebhooks(prisma).catch(() => undefined);
  return id;
}

/** How many deliveries the last pass found due (diagnostics). */
let consecutiveDue = 0;

/**
 * Consume one round of due deliveries. Returns the number of deliveries claimed.
 * Called by the kernel recurring job; safe to call directly in tests.
 */
export async function processDueWebhooks(
  prisma: PrismaClient,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const repo = new ResellerRepository(prisma);
  const due = await repo.dueDeliveries();
  consecutiveDue = due.length;
  let claimed = 0;
  for (const delivery of due) {
    if (!(await repo.claimDelivery(delivery.id))) continue;
    claimed += 1;
    await deliverOne(repo, delivery, fetchImpl);
  }
  return claimed;
}

/** Number of due deliveries seen on the last pass (diagnostics). */
export function dueDeliveryCount(): number {
  return consecutiveDue;
}

async function deliverOne(
  repo: ResellerRepository,
  delivery: WebhookDeliveryRecord,
  fetchImpl: typeof fetch,
): Promise<void> {
  const reseller = await repo.findById(delivery.resellerId);
  if (!reseller) {
    await repo.markFailed(delivery.id, '渠道不存在');
    return;
  }
  const body = JSON.stringify(delivery.payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const { path } = splitUrl(delivery.url);
  const canonical = canonicalRequest({
    method: 'POST',
    path,
    timestamp,
    nonce: delivery.id,
    bodyDigest: bodyDigest(body),
  });

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-sp-event': delivery.event,
    'x-sp-delivery': delivery.id,
    'x-sp-timestamp': timestamp,
  };
  if (reseller.webhookPrivateKey) {
    const privateKey = revealPrivateKey(reseller.webhookPrivateKey);
    if (!privateKey) {
      await repo.markFailed(delivery.id, '回调签名私钥无法解密');
      return;
    }
    try {
      headers['x-sp-key-id'] = reseller.keyId;
      headers['x-sp-signature'] = signCanonical(canonical, privateKey);
    } catch {
      await repo.markFailed(delivery.id, '回调签名失败');
      return;
    }
  }

  // SSRF 防护（审计 M-3）：回调地址必须为公网 HTTPS，且当前解析不落到内网。
  if (
    !isPublicHttpUrl(delivery.url) ||
    (await resolvesToUnsafeAddress(new URL(delivery.url).hostname))
  ) {
    await repo.markFailed(delivery.id, '回调地址必须解析到公网地址');
    return;
  }

  const attempt = delivery.attempts + 1;
  try {
    const requestInit: RequestInit = {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    };
    const response = fetchImpl === fetch
      ? await pinnedFetch(delivery.url, requestInit)
      : await fetchImpl(delivery.url, requestInit);
    if (response.ok) {
      await repo.markDelivered(delivery.id, response.status);
      return;
    }
    const error = `HTTP ${response.status}`;
    if (attempt >= delivery.maxAttempts) {
      await repo.markFailed(delivery.id, error);
    } else {
      await repo.markRetry(delivery.id, error, new Date(Date.now() + backoffMs(attempt)));
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (attempt >= delivery.maxAttempts) {
      await repo.markFailed(delivery.id, error.slice(0, 500));
    } else {
      await repo.markRetry(delivery.id, error.slice(0, 500), new Date(Date.now() + backoffMs(attempt)));
    }
  }
}

/** path + query for canonicalisation (fall back to the raw url on parse failure). */
function splitUrl(url: string): { path: string } {
  try {
    const parsed = new URL(url);
    return { path: `${parsed.pathname}${parsed.search}` };
  } catch {
    return { path: url };
  }
}
