import 'server-only';

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { cookies } from 'next/headers';

/**
 * 一次性 flash 回执：URL 只带一个随机 token，正文放在**加密签名 cookie** 里。
 *
 * 为什么需要它：`?error=` / `?success=` 只允许传 code（见
 * `lib/action-feedback-codes.ts`），但有些回执天生带动态内容——「已更新 3 个
 * 商品，跳过 1 个」、上游返回的原文、被拒绝的具体原因。把这些塞进 URL 就等于
 * 把任意文本反射到站内 toast（钓鱼面），也会进浏览器历史、进日志、被分享出去。
 *
 * 设计要点：
 *
 * - **不进 URL 正文**：URL 只有 `?flash=<uuid>`，猜不到、不能注入；
 * - **一次有效**：读的时候立刻删除 cookie，刷新/后退不会重复弹；
 * - **60 秒过期**：写进 cookie 的值带 `exp`，过期即丢弃；
 * - **签名 + 加密**：正文用 HMAC-SHA256 派生的密钥做 AES-256-GCM，篡改直接解不开。
 *   密钥来自 `SESSION_SECRET`（与 API 共用），缺失时降级为**不落盘**——即回执丢失，
 *   而不是退化成明文 cookie。
 */

const FLASH_COOKIE_PREFIX = 'sp_flash_';
const FLASH_TTL_SECONDS = 60;
const MAX_FLASH_CHARS = 2_000;

export interface FlashPayload {
  kind: 'error' | 'success';
  /** 已本地化的短文本（服务端生成，非用户输入）。 */
  message: string;
  /** 稳定错误码，界面可据此分支。 */
  code?: string;
  /** 请求 id，操作者拿它去日志里找原因。 */
  requestId?: string;
}

/** 派生一把只在 flash 用途上使用的 32 字节密钥。 */
function flashKey(): Buffer | null {
  const secret = process.env.SESSION_SECRET ?? process.env.JWT_SECRET;
  if (!secret || secret.length < 16) return null;
  return createHash('sha256').update(`sp-flash:${secret}`).digest();
}

function encrypt(key: Buffer, plaintext: string): string {
  // 每次都用新的随机 IV；GCM 的 IV 复用会直接摧毁机密性与完整性。
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    body.toString('base64url'),
  ].join('.');
}

function decrypt(key: Buffer, token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [ivPart, tagPart, bodyPart] = parts as [string, string, string];
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(bodyPart, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** 写一条 flash，返回要放进 URL 的 token；`null` 表示回执只能靠 code 表达。 */
export async function writeActionFlash(payload: FlashPayload): Promise<string | null> {
  const key = flashKey();
  if (!key) return null;
  const message = payload.message.slice(0, MAX_FLASH_CHARS);
  const token = randomUUID();
  const envelope = JSON.stringify({
    ...payload,
    message,
    exp: Date.now() + FLASH_TTL_SECONDS * 1000,
  });
  const store = await cookies();
  store.set(`${FLASH_COOKIE_PREFIX}${token}`, encrypt(key, envelope), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: FLASH_TTL_SECONDS,
  });
  return token;
}

/**
 * 读一条 flash 并**立即作废**它。
 *
 * 浏览器端读不到（cookie 是 httpOnly），所以消费点在服务端组件里：页面把它
 * 渲染成一次性的行内提示 / 传给客户端 toaster。
 */
export async function consumeActionFlash(token: string): Promise<FlashPayload | null> {
  const key = flashKey();
  if (!key) return null;
  const store = await cookies();
  const name = `${FLASH_COOKIE_PREFIX}${token}`;
  const raw = store.get(name)?.value;
  if (!raw) return null;
  store.delete(name);
  const plaintext = decrypt(key, raw);
  if (!plaintext) return null;
  try {
    const parsed = JSON.parse(plaintext) as FlashPayload & { exp?: number };
    if (typeof parsed.exp !== 'number' || parsed.exp < Date.now()) return null;
    if (parsed.kind !== 'error' && parsed.kind !== 'success') return null;
    if (typeof parsed.message !== 'string') return null;
    return {
      kind: parsed.kind,
      message: parsed.message,
      ...(typeof parsed.code === 'string' ? { code: parsed.code } : {}),
      ...(typeof parsed.requestId === 'string' ? { requestId: parsed.requestId } : {}),
    };
  } catch {
    return null;
  }
}

/** 常量时间比较，避免把签名校验变成计时侧信道（供将来加签 URL 时使用）。 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** 供测试与文档引用：flash 的有效期（秒）。 */
export const ACTION_FLASH_TTL_SECONDS = FLASH_TTL_SECONDS;
