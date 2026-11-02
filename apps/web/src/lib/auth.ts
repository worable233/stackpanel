import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { ApiClient, ApiError } from '@stackpanel/sdk';
import { sessionCookieName } from './session-cookie';

export interface SessionUser {
  sub: string;
  role: 'ADMIN' | 'USER';
}

/**
 * 会话解析的结果。
 *
 * 三态而不是 `SessionUser | null`：`null` 把「没人登录」和「内核现在连不上」
 * 混成同一件事，而两者的正确反应完全相反。
 *
 * 事故：api 重启的那几十秒里，`getSessionUser()` 抛错 → 被 `catch` 吞成 null
 * → 布局组件认为访客未登录 → `redirect('/login')`。用户被踢出登录态，刚填的
 * 表单内容全没，而他的会话压根没过期。更糟的是 `proxy.ts` 对 `/admin/*` 也做
 * 同一件事，所以整个后台一起被踢。
 */
export type SessionState =
  | { kind: 'authenticated'; user: SessionUser }
  /** 确定没有有效会话（无 cookie，或内核明确回答 401/403）。 */
  | { kind: 'anonymous' }
  /** 无法判断（5xx、超时、网络错误）。**不能**当作未登录处理。 */
  | { kind: 'unavailable' };

function cookieName(): string {
  // Same single source as the writer (`session-cookie.ts`): reader and writer
  // disagreeing on the name is the failure mode that logs everyone out at once.
  return sessionCookieName();
}

function apiBaseUrl(): string {
  return process.env.API_BASE_URL ?? 'http://127.0.0.1:3001';
}

/** Read the opaque session token from the cookie if present. */
export async function getSessionToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(cookieName())?.value ?? null;
}

/**
 * Resolve the current session via the API.
 *
 * 区分「匿名」与「问不到」。只有内核明确说“没有这个会话”时才是匿名；连接
 * 失败、超时、5xx 一律是 `unavailable`——把这种情形当成未登录，就会在 api 重启
 * 窗口把所有人踢出登录，并丢掉他们正在填的东西。
 */
export const getSessionState = cache(async (): Promise<SessionState> => {
  const token = await getSessionToken();
  if (!token) return { kind: 'anonymous' };
  try {
    const result = await new ApiClient({ baseUrl: apiBaseUrl(), token }).getSession();
    if (!result.user) return { kind: 'anonymous' };
    return { kind: 'authenticated', user: { sub: result.user.id, role: result.user.role } };
  } catch (error) {
    if (error instanceof ApiError) {
      // 明确的凭证结论：会话真的没了/被吊销。
      if (error.status === 401 || error.status === 403) return { kind: 'anonymous' };
      // status 0 = 网络失败/超时；5xx = 内核或依赖故障。都不是“你没登录”。
      return { kind: 'unavailable' };
    }
    return { kind: 'unavailable' };
  }
});

/**
 * Resolve the current session user, or null when anonymous.
 *
 * 注意：`null` 同时包含“未登录”和“问不到内核”两种情形，只适合**不据此踢人**
 * 的地方（例如决定是否显示一个可选区块）。任何会 `redirect('/login')` 的调用
 * 方都必须改用 `getSessionState()`，否则 api 抖一下就把用户踢出去。
 *
 * Sessions are server-side (ADR-0017 §4), so the web app no longer decodes a
 * JWT locally: it asks the kernel, which is the only authority on session
 * validity. Deduplicated per request with React `cache`.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const state = await getSessionState();
  return state.kind === 'authenticated' ? state.user : null;
});
