/**
 * 平台 API 密钥的请求签名（对标 #12.6）。
 *
 * 复用 SP v1 已经存在的签名方案，不引入第二套：能力是对外契约，签名也应只有
 * 一种是「我们要求客户怎么做」的答案。canonical 与
 * `packages/plugins/channel/src/signing.ts` 逐字节一致：
 *
 *   `<METHOD>\n<path+query>\n<timestamp>\n<nonce>\n<sha256hex(body)>`
 *
 * 因此同一段客户代码既可用于 `/sp/v1/*`（渠道伙伴，`X-SP-Key-Id` 选密钥），
 * 也可用于 `/api/v1/*`（平台凭证，密钥由 token 自身决定，故无 Key-Id 头）。
 *
 * 与 SP v1 的三条约束完全对应：
 *   - 时间戳只在 ±{@link SIGNATURE_WINDOW_SECONDS} 秒内有效，截获的签名会过期；
 *   - nonce 单次使用，落在共享状态里，跨副本重放一样被拒；
 *   - 签名覆盖请求体的**原始字节**，改一个字节就失配。
 *
 * 边界：签名是**绝对**约束，不是加分项。token 一旦登记了公钥，不带签名的请求
 * 一律 401 —— 否则「登记了公钥」这件事就没有任何保证，比不登记更危险。
 * 未登记公钥的 token 保持原有 Bearer 行为不变（迁移不能中断存量客户）。
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { PluginError } from '@stackpanel/sdk';
import { getStateService } from '../state/index.ts';
import { rawBodyText } from '../plugins/body.ts';

export const REQUEST_SIGNATURE_HEADERS = {
  timestamp: 'x-sp-timestamp',
  nonce: 'x-sp-nonce',
  signature: 'x-sp-signature',
} as const;

/** 允许的时钟偏移（秒）。与 SP v1 保持一致。 */
export const SIGNATURE_WINDOW_SECONDS = 300;

/** nonce 长度上限，避免共享状态被超长键污染。 */
const MAX_NONCE_LENGTH = 128;

/** sha256 hex of a request body (empty string for no body). */
export function bodyDigest(body: string | Uint8Array | undefined): string {
  const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(body);
  return createHash('sha256').update(bytes).digest('hex');
}

/** 客户要签的那一行字符串。 */
export function canonicalRequest(input: {
  method: string;
  /** 含 query string 的路径，如 `/api/v1/users?page=1`。 */
  path: string;
  timestamp: string;
  nonce: string;
  bodyDigest: string;
}): string {
  return [
    input.method.toUpperCase(),
    input.path,
    input.timestamp,
    input.nonce,
    input.bodyDigest,
  ].join('\n');
}

/** 校验 Ed25519 公钥（PEM）。 */
export function isValidEd25519PublicKey(publicKey: string): boolean {
  try {
    return createPublicKey(publicKey).asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

/** base64 Ed25519 签名校验；任何异常都视为不通过。 */
export function verifyCanonical(
  canonical: string,
  signatureBase64: string,
  publicKeyPem: string,
): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') return false;
    const signature = Buffer.from(signatureBase64, 'base64');
    if (signature.length === 0) return false;
    return verify(null, Buffer.from(canonical, 'utf8'), key, signature);
  } catch {
    return false;
  }
}

export interface SignatureHeaders {
  timestamp: string;
  nonce: string;
  signature: string;
}

/** 读取三个签名头；任一缺失即视为未签名。 */
export function readSignatureHeaders(
  headers: Record<string, unknown>,
): SignatureHeaders | null {
  const pick = (name: string): string | null => {
    const value = headers[name];
    const raw = Array.isArray(value) ? value[0] : value;
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
  };
  const timestamp = pick(REQUEST_SIGNATURE_HEADERS.timestamp);
  const nonce = pick(REQUEST_SIGNATURE_HEADERS.nonce);
  const signature = pick(REQUEST_SIGNATURE_HEADERS.signature);
  if (!timestamp || !nonce || !signature) return null;
  if (nonce.length > MAX_NONCE_LENGTH) return null;
  return { timestamp, nonce, signature };
}

export type SignatureVerdict =
  | { ok: true }
  | { ok: false; reason: 'malformed' | 'expired' | 'invalid' };

/**
 * 纯函数部分：时间窗口 + 签名匹配。nonce 重放要共享状态，由
 * {@link enforceApiTokenSignature} 负责。
 */
export function verifySignature(
  input: {
    method: string;
    path: string;
    timestamp: string;
    nonce: string;
    signature: string;
    body?: string | Uint8Array;
    /** 注入当前时间（epoch ms）以便确定性测试。 */
    now?: number;
  },
  publicKeyPem: string,
): SignatureVerdict {
  if (!/^\d{1,20}$/.test(input.timestamp)) return { ok: false, reason: 'malformed' };
  const sentSeconds = Number(input.timestamp);
  const nowSeconds = Math.floor((input.now ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - sentSeconds) > SIGNATURE_WINDOW_SECONDS) {
    return { ok: false, reason: 'expired' };
  }
  const canonical = canonicalRequest({
    method: input.method,
    path: input.path,
    timestamp: input.timestamp,
    nonce: input.nonce,
    bodyDigest: bodyDigest(input.body),
  });
  return verifyCanonical(canonical, input.signature, publicKeyPem)
    ? { ok: true }
    : { ok: false, reason: 'invalid' };
}

function reject(code: string, detail: string): never {
  throw new PluginError(code, 401, detail);
}

/** 该请求的原始字节；拿不到就返回 `undefined`（见下方「不可签名的请求」）。 */
function rawBody(request: FastifyRequest): string | undefined {
  if (request.body === undefined) return '';
  return rawBodyText(request);
}

/**
 * 对一枚已登记公钥的平台凭证强制执行请求签名。
 *
 * 失败时抛 {@link PluginError}（401 + 稳定 code），由统一错误处理渲染成
 * RFC 7807 —— 与其它鉴权失败同一条出口，不额外造一套响应格式。
 */
export async function enforceApiTokenSignature(
  request: FastifyRequest,
  tokenId: string,
  publicKey: string,
): Promise<void> {
  const headers = readSignatureHeaders(request.headers as Record<string, unknown>);
  if (!headers) {
    reject('request.signature_missing', '该凭证已启用请求签名，缺少 X-SP-Signature 等签名头');
  }
  const body = rawBody(request);
  if (body === undefined) {
    // 有请求体但不是 JSON（如 multipart 上传）：原始字节没有留存，无法校验。
    // 宁可拒绝，也不能「验不了就放行」。
    reject('request.signature_unsupported', '该请求体的类型不支持请求签名校验');
  }
  const verdict = verifySignature(
    {
      method: request.method,
      path: request.url,
      timestamp: headers.timestamp,
      nonce: headers.nonce,
      signature: headers.signature,
      body,
    },
    publicKey,
  );
  if (!verdict.ok) {
    if (verdict.reason === 'expired') {
      reject('request.signature_expired', '请求时间戳超出允许窗口');
    }
    reject(
      'request.signature_invalid',
      verdict.reason === 'malformed' ? '签名头格式无效' : '请求签名无效（或被篡改）',
    );
  }
  // 签名有效才消耗 nonce：无效签名不该占用共享状态。
  const firstUse = await getStateService().acquire(
    `apisig:nonce:${tokenId}:${headers.nonce}`,
    (SIGNATURE_WINDOW_SECONDS + 60) * 1000,
  );
  if (!firstUse) {
    reject('request.signature_replayed', '该签名已被使用（防重放）');
  }
}
