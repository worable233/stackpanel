/**
 * SP v1 authentication guard (P3).
 *
 * A reseller request is authenticated by an Ed25519 signature (see
 * {@link verifyRequestSignature}) plus two shared-state protections that must
 * hold across replicas:
 *
 *   - **Nonce replay**: a valid signature is single-use. The nonce is consumed
 *     in the shared {@link StateService} (Redis in a cluster) with a TTL equal
 *     to the signature window, so the exact same signed request cannot be
 *     replayed — even against a different replica.
 *   - **Rate limit**: per-reseller RPM, counted in shared state so the ceiling
 *     holds cluster-wide.
 *
 * Body integrity is signed over the raw request bytes; {@link captureSpRawBody}
 * buffers them before the JSON parser runs.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { getStateService } from '../state/index.ts';
import { buildProblem } from '../lib/problem.ts';
import { getPrisma } from '../plugins/prisma.ts';
import { readSignatureHeaders, SIGNATURE_WINDOW_SECONDS, verifyRequestSignature } from './signing.ts';
import { ResellerRepository, type ResellerRecord } from './repository.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** Raw request body bytes for SP v1 signature verification. */
    spRawBody?: string;
    /** The authenticated reseller (set by {@link authenticateReseller}). */
    reseller?: ResellerRecord;
  }
}

/** Max raw body buffered for signature verification (matches the kernel limit). */
const MAX_SP_BODY_BYTES = 1_048_576;
const NONCE_PREFIX = 'spv1:nonce:';
const RPM_PREFIX = 'spv1:rpm:';

function codedError(statusCode: number, code: string, detail: string): Error {
  const err = new Error(detail) as Error & { statusCode: number; code: string };
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

/**
 * Buffer the raw request body for `/sp/v1/*` so the signature can be verified
 * over the exact bytes the partner signed. Registered as a `preParsing` hook
 * scoped to the SP v1 plugin context; other routes are untouched.
 */
export async function captureSpRawBody(
  request: FastifyRequest,
  _reply: FastifyReply,
  payload: NodeJS.ReadableStream,
): Promise<NodeJS.ReadableStream> {
  if (!request.url.startsWith('/sp/v1/')) return payload as Readable;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of payload as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_SP_BODY_BYTES) {
      throw codedError(413, 'sp_v1.body_too_large', '请求体过大');
    }
    chunks.push(chunk);
  }
  request.spRawBody = Buffer.concat(chunks).toString('utf8');
  return Readable.from(chunks);
}

async function reject(
  reply: FastifyReply,
  status: number,
  code: string,
  detail: string,
): Promise<null> {
  await reply.code(status).send(buildProblem({ status, code, detail }));
  return null;
}

/**
 * Authenticate a reseller request. Returns the resolved reseller, or null after
 * already sending the appropriate problem response (401/429).
 */
export async function authenticateReseller(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<ResellerRecord | null> {
  const headers = readSignatureHeaders(request.headers as Record<string, unknown>);
  if (!headers) {
    return reject(reply, 401, 'sp_v1.signature_missing', '缺少 SP v1 签名头');
  }

  const repo = new ResellerRepository(getPrisma());
  const reseller = await repo.findByKeyId(headers.keyId);
  if (!reseller || reseller.status !== 'ACTIVE') {
    return reject(reply, 401, 'sp_v1.key_unknown', '渠道密钥无效或已停用');
  }

  const verdict = verifyRequestSignature(
    {
      method: request.method,
      path: request.url,
      timestamp: headers.timestamp,
      nonce: headers.nonce,
      signature: headers.signature,
      ...(request.spRawBody !== undefined ? { body: request.spRawBody } : {}),
    },
    reseller.publicKey,
  );
  if (!verdict.ok) {
    if (verdict.reason === 'expired') {
      return reject(reply, 401, 'sp_v1.signature_expired', '请求时间戳超出允许窗口');
    }
    return reject(reply, 401, 'sp_v1.signature_invalid', '请求签名无效');
  }

  // Single-use nonce: consume it for the lifetime of the signature window.
  const firstUse = await getStateService().acquire(
    `${NONCE_PREFIX}${reseller.keyId}:${headers.nonce}`,
    (SIGNATURE_WINDOW_SECONDS + 60) * 1000,
  );
  if (!firstUse) {
    return reject(reply, 401, 'sp_v1.nonce_replayed', '该签名已被使用（防重放）');
  }

  if (reseller.rateLimitRpm > 0) {
    const hits = await getStateService().incr(`${RPM_PREFIX}${reseller.id}`, 60_000);
    if (hits > reseller.rateLimitRpm) {
      reply.header('retry-after', '60');
      return reject(reply, 429, 'sp_v1.rate_limited', '请求过于频繁，请稍后再试');
    }
  }

  void repo.touch(reseller.id, request.ip).catch(() => undefined);
  request.reseller = reseller;
  return reseller;
}

/** Scope check for one SP v1 operation. Sends 403 when the reseller lacks it. */
export async function requireResellerScope(
  request: FastifyRequest,
  reply: FastifyReply,
  scope: string,
): Promise<boolean> {
  const scopes = request.reseller?.scopes ?? [];
  if (!scopes.includes(scope)) {
    await reply
      .code(403)
      .send(
        buildProblem({
          status: 403,
          code: 'sp_v1.scope_forbidden',
          detail: `缺少能力授权：${scope}`,
        }),
      );
    return false;
  }
  return true;
}
