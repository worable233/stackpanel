import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient } from '@stackpanel/db';
import { env } from '../config/env.ts';

/**
 * 内核平台凭证（ApiToken）：签发、解析、鉴权。
 *
 * - 明文格式：`${prefix}${base64url(24 bytes)}`，只在创建时返回一次。
 * - 库里只存 `sha256(明文)` 与打码前缀。
 * - 有效权限恒为 `token.scopes ∩ 持有者当前权限`，在请求时求交集。
 */

/** 平台默认前缀；可由 STACKPANEL_API_TOKEN_PREFIX 覆盖。 */
export const DEFAULT_API_TOKEN_PREFIX = 'sp_';

/** `lastUsedAt` 写回节流窗口：最多 5 分钟落一次库。 */
const LAST_USED_THROTTLE_MS = 5 * 60_000;

/** 历史网关密钥前缀，作为兼容别名继续接受。 */
export const LEGACY_GATEWAY_PREFIX = 'sk-sp-';

export function apiTokenPrefix(): string {
  return env.STACKPANEL_API_TOKEN_PREFIX ?? DEFAULT_API_TOKEN_PREFIX;
}

/** 该明文是否长得像一枚平台凭证（默认前缀或历史前缀）。 */
export function looksLikeApiToken(plaintext: string): boolean {
  return plaintext.startsWith(apiTokenPrefix()) || plaintext.startsWith(LEGACY_GATEWAY_PREFIX);
}

export interface GeneratedApiToken {
  /** 明文；只在创建时返回一次，不入库。 */
  plaintext: string;
  /** sha256(明文)，用于查找。 */
  keyHash: string;
  /** 展示用打码前缀。 */
  keyPrefix: string;
}

/** 生成一枚新的平台凭证。 */
export function generateApiToken(): GeneratedApiToken {
  const plaintext = `${apiTokenPrefix()}${randomBytes(24).toString('base64url')}`;
  return {
    plaintext,
    keyHash: hashApiToken(plaintext),
    keyPrefix: `${plaintext.slice(0, 12)}…`,
  };
}

/** 计算凭证哈希（高熵随机串，sha256 即可，无需慢哈希）。 */
export function hashApiToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/** 将 IPv4 解析成 32 位整数；失败返回 null。 */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

/** 将 IPv6 解析成 128 位 BigInt；失败返回 null。 */
function ipv6ToBigInt(ip: string): bigint | null {
  // 去掉 zone id 与包裹方括号。
  const text = ip.replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  if (text.length === 0 || !text.includes(':')) return null;
  const dbl = text.indexOf('::');
  let head: string[];
  let tail: string[];
  if (dbl >= 0) {
    head = text.slice(0, dbl).split(':').filter((s) => s.length > 0);
    tail = text.slice(dbl + 2).split(':').filter((s) => s.length > 0);
  } else {
    head = text.split(':');
    tail = [];
  }
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const groups = [...head, ...Array(missing).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

/** 单个 allowlist 条目是否匹配客户端 IP（支持单 IP 与 CIDR，v4/v6）。 */
function entryMatches(entry: string, ip: string): boolean {
  const trimmed = entry.trim();
  if (!trimmed) return false;
  if (trimmed === ip) return true;
  const slash = trimmed.indexOf('/');
  if (slash < 0) return false;
  const network = trimmed.slice(0, slash);
  const bits = Number(trimmed.slice(slash + 1));
  if (!Number.isInteger(bits)) return false;
  const v4 = ipv4ToInt(network);
  const v4ip = ipv4ToInt(ip);
  if (v4 !== null && v4ip !== null) {
    if (bits < 0 || bits > 32) return false;
    if (bits === 0) return true;
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return (v4ip & mask) === (v4 & mask);
  }
  const v6 = ipv6ToBigInt(network);
  const v6ip = ipv6ToBigInt(ip);
  if (v6 !== null && v6ip !== null) {
    if (bits < 0 || bits > 128) return false;
    if (bits === 0) return true;
    const shift = 128n - BigInt(bits);
    return (v6ip >> shift) === (v6 >> shift);
  }
  return false;
}

/** 客户端 IP 是否被 allowlist 允许；空列表表示不限制。 */
export function ipAllowed(allowlist: unknown, ip: string | undefined): boolean {
  const list = toStringArray(allowlist);
  if (list.length === 0) return true;
  if (!ip) return false;
  return list.some((entry) => entryMatches(entry, ip));
}

/** 宽松地把 Json 字段读成 string[]。 */
export function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

export interface ResolvedApiToken {
  tokenId: string;
  userId: string;
  /** token 声明的 scope（未与用户权限求交）。 */
  scopes: string[];
}

/**
 * 校验一枚明文凭证，返回其所属用户与 scope。
 * 命中时顺带更新 `lastUsedAt`/`lastUsedIp`；节流到 5 分钟一次，避免每请求一次写。
 */
export async function resolveApiToken(
  db: PrismaClient,
  plaintext: string,
  clientIp?: string,
): Promise<ResolvedApiToken | null> {
  const token = await db.apiToken.findUnique({ where: { keyHash: hashApiToken(plaintext) } });
  if (!token) return null;
  if (token.status !== 'ACTIVE') return null;
  if (token.expiresAt && token.expiresAt.getTime() <= Date.now()) return null;
  if (!ipAllowed(token.ipAllowlist, clientIp)) return null;

  const stale =
    !token.lastUsedAt || Date.now() - token.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS;
  if (stale) {
    void db.apiToken
      .update({
        where: { id: token.id },
        data: { lastUsedAt: new Date(), ...(clientIp ? { lastUsedIp: clientIp } : {}) },
      })
      .catch(() => undefined);
  }

  return {
    tokenId: token.id,
    userId: token.userId,
    scopes: toStringArray(token.scopes),
  };
}
