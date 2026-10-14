/**
 * SP v1 authentication guard (moved out of the kernel under ADR-0021 §D4).
 *
 * A partner request is authenticated by an Ed25519 signature plus two
 * shared-state protections that hold across replicas:
 *
 *   - **Nonce replay**: a valid signature is single-use; the nonce is consumed in
 *     shared state (`ctx.state`) for the signature window.
 *   - **Rate limit**: per-partner RPM, counted in shared state.
 *
 * Body integrity is signed over the exact raw bytes; the raw route reads them
 * once ({@link readBodyText}) and the guard verifies against those bytes.
 */
import type { RawHttpReply, RawHttpRequest } from '@stackpanel/sdk';
import { stateService } from './context';
import { ChannelRepository, type PartnerRecord } from './repository';
import {
  readSignatureHeaders,
  SIGNATURE_WINDOW_SECONDS,
  verifyRequestSignature,
} from './signing';

const MAX_SP_BODY_BYTES = 1_048_576;
const NONCE_PREFIX = 'spv1:nonce:';
const RPM_PREFIX = 'spv1:rpm:';

/** Read the raw request body to a string (bounded), or '' when empty. */
export async function readBodyText(request: RawHttpRequest): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.body as AsyncIterable<Buffer | string>) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_SP_BODY_BYTES) {
      throw Object.assign(new Error('请求体过大'), {
        statusCode: 413,
        code: 'sp_v1.body_too_large',
      });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Write a problem+json body and end the raw response. */
export function problemReply(
  reply: RawHttpReply,
  status: number,
  code: string,
  detail: string,
  instance?: string,
): void {
  reply.header('content-type', 'application/problem+json; charset=utf-8');
  reply.status(status);
  reply.end(
    JSON.stringify({
      type: 'about:blank',
      title:
        status === 429
          ? 'Too Many Requests'
          : status === 403
            ? 'Forbidden'
            : status === 413
              ? 'Payload Too Large'
              : 'Unauthorized',
      status,
      code,
      detail,
      ...(instance ? { instance } : {}),
    }),
  );
}

function reject(
  reply: RawHttpReply,
  status: number,
  code: string,
  detail: string,
): { ok: false; status: number } {
  problemReply(reply, status, code, detail);
  return { ok: false, status };
}

export interface AuthenticatedPartner {
  ok: true;
  partner: PartnerRecord;
  bodyText: string;
}

export type AuthOutcome = AuthenticatedPartner | { ok: false; status: number };

/**
 * Authenticate a partner request. Returns the resolved partner + raw body, or a
 * failure outcome after already ending the response with the appropriate problem
 * (401/413/429). The failure status is returned so the caller can audit it.
 */
export async function authenticatePartner(
  request: RawHttpRequest,
  reply: RawHttpReply,
): Promise<AuthOutcome> {
  let bodyText: string;
  try {
    bodyText = await readBodyText(request);
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode ?? 413;
    return reject(reply, status, 'sp_v1.body_too_large', '请求体过大');
  }

  const headers = readSignatureHeaders(request.headers as Record<string, unknown>);
  if (!headers) {
    return reject(reply, 401, 'sp_v1.signature_missing', '缺少 SP v1 签名头');
  }

  const repo = new ChannelRepository();
  const partner = await repo.findByKeyId(headers.keyId);
  if (!partner || partner.status !== 'ACTIVE') {
    return reject(reply, 401, 'sp_v1.key_unknown', '渠道密钥无效或已停用');
  }

  const verdict = verifyRequestSignature(
    {
      method: request.method,
      path: request.url,
      timestamp: headers.timestamp,
      nonce: headers.nonce,
      signature: headers.signature,
      body: bodyText,
    },
    partner.publicKey,
  );
  if (!verdict.ok) {
    if (verdict.reason === 'expired') {
      return reject(reply, 401, 'sp_v1.signature_expired', '请求时间戳超出允许窗口');
    }
    return reject(reply, 401, 'sp_v1.signature_invalid', '请求签名无效');
  }

  const store = stateService();
  const firstUse = await store.acquire(
    `${NONCE_PREFIX}${partner.keyId}:${headers.nonce}`,
    (SIGNATURE_WINDOW_SECONDS + 60) * 1000,
  );
  if (!firstUse) {
    return reject(reply, 401, 'sp_v1.nonce_replayed', '该签名已被使用（防重放）');
  }

  if (partner.rateLimitRpm > 0) {
    const hits = await store.incr(`${RPM_PREFIX}${partner.id}`, 60_000);
    if (hits > partner.rateLimitRpm) {
      reply.header('retry-after', '60');
      return reject(reply, 429, 'sp_v1.rate_limited', '请求过于频繁，请稍后再试');
    }
  }

  void repo.touch(partner.id, request.ip).catch(() => undefined);
  return { ok: true, partner, bodyText };
}

/** Scope check for one SP v1 operation. Ends with 403 when the partner lacks it. */
export async function requirePartnerScope(
  reply: RawHttpReply,
  partner: PartnerRecord,
  scope: string,
): Promise<boolean> {
  if (!partner.scopes.includes(scope)) {
    problemReply(reply, 403, 'sp_v1.scope_forbidden', `缺少能力授权：${scope}`);
    return false;
  }
  return true;
}
