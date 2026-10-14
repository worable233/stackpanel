/**
 * SP v1 signed webhook dispatch (moved out of the kernel under ADR-0021 §D4).
 *
 * Lifecycle events (order.provisioned / service.suspended etc.) are pushed to
 * partners through signed callbacks. Delivery is at-least-once: a delivery row is
 * written (PENDING), then the plugin's recurring job claims and POSTs it; success
 * marks SUCCEEDED, failures back off and retry, and past the attempt cap become
 * FAILED.
 *
 * The callback body is Ed25519-signed with the same canonical string as inbound
 * requests (nonce = delivery id), so partners verify with the same algorithm.
 * The delivery id doubles as the idempotency key for partner-side dedupe.
 */
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isPublicHttpUrl, resolvePublicAddresses } from '@stackpanel/net-guard';
import { bodyDigest, canonicalRequest, signCanonical } from './signing';
import { revealWebhookPrivateKey } from './keys';
import { ChannelRepository, type PartnerRecord, type DeliveryRecord } from './repository';

export const WEBHOOK_JOBS = { deliver: 'webhook-deliver' } as const;

const DEFAULT_MAX_ATTEMPTS = 6;
const REQUEST_TIMEOUT_MS = 10_000;

/** Fetch using the address that was checked for SSRF, preserving Host/SNI. */
export async function pinnedFetch(
  urlValue: string,
  init: RequestInit,
  addresses: readonly string[],
): Promise<Response> {
  const url = new URL(urlValue);
  const address = addresses[0];
  if (!address) throw new Error('回调地址无法解析');
  const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = requestFn(
      {
        protocol: url.protocol,
        hostname: address,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? 'GET',
        headers: { ...(init.headers as Record<string, string> | undefined), host: url.host },
        ...(url.protocol === 'https:' ? { servername: url.hostname } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () =>
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode ?? 502,
              headers: Object.fromEntries(
                Object.entries(res.headers).flatMap(([key, value]) =>
                  typeof value === 'string'
                    ? [[key, value]]
                    : value
                      ? [[key, value.join(', ')]]
                      : [],
                ),
              ),
            }),
          ),
        );
        res.on('error', reject);
      },
    );
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
 * partner has no callback URL configured (nothing to deliver).
 */
export async function enqueueWebhook(
  partner: PartnerRecord,
  event: string,
  data: unknown,
): Promise<string | null> {
  if (!partner.webhookUrl) return null;
  const repo = new ChannelRepository();
  const id = `wh_${randomUUID()}`;
  const envelope: WebhookEnvelope = {
    id,
    event,
    createdAt: new Date().toISOString(),
    data,
  };
  await repo.createDelivery({
    id,
    partnerId: partner.id,
    event,
    url: partner.webhookUrl,
    payload: envelope,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
  });
  void processDueWebhooks(repo).catch(() => undefined);
  return id;
}

/** How many deliveries the last pass found due (diagnostics). */
let consecutiveDue = 0;

/**
 * Consume one round of due deliveries. Returns the number claimed. Called by the
 * plugin's recurring job; safe to call directly in tests.
 */
export async function processDueWebhooks(
  repo: ChannelRepository = new ChannelRepository(),
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
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
  repo: ChannelRepository,
  delivery: DeliveryRecord,
  fetchImpl: typeof fetch,
): Promise<void> {
  const partner = await repo.findById(delivery.partnerId);
  if (!partner) {
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
  if (partner.webhookPrivateKeyRef) {
    const privateKey = await revealWebhookPrivateKey(partner.webhookPrivateKeyRef);
    if (!privateKey) {
      await repo.markFailed(delivery.id, '回调签名私钥无法解密');
      return;
    }
    try {
      headers['x-sp-key-id'] = partner.keyId;
      headers['x-sp-signature'] = signCanonical(canonical, privateKey);
    } catch {
      await repo.markFailed(delivery.id, '回调签名失败');
      return;
    }
  }

  // SSRF defense: the callback must resolve to a public address, resolved once
  // and reused for the connection to avoid a check-then-connect TOCTOU. A test
  // `fetchImpl` bypasses the pin.
  if (!isPublicHttpUrl(delivery.url)) {
    await repo.markFailed(delivery.id, '回调地址必须解析到公网地址');
    return;
  }
  const pinnedAddresses =
    fetchImpl === fetch ? await resolvePublicAddresses(new URL(delivery.url).hostname) : undefined;
  if (fetchImpl === fetch && (!pinnedAddresses || pinnedAddresses.length === 0)) {
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
    const response =
      fetchImpl === fetch && pinnedAddresses
        ? await pinnedFetch(delivery.url, requestInit, pinnedAddresses)
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
      await repo.markRetry(
        delivery.id,
        error.slice(0, 500),
        new Date(Date.now() + backoffMs(attempt)),
      );
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
