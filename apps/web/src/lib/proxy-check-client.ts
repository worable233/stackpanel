/**
 * 浏览器侧的反代自检客户端。
 *
 * 为什么要浏览器直接打内核，而不是像其它后台数据那样走 BFF：
 *
 * 这个检查要判断的是「**浏览器 → 反代 → 内核**」这一跳有没有正确传递协议与真实 IP。
 * 走 BFF 时请求变成「浏览器 → 反代 → web → api」，`web → api` 是内网直连，永远
 * 没有 `X-Forwarded-Proto` / `X-Forwarded-For` —— 测出来的是一片假绿。
 *
 * 后台上原本的 BFF 代理（`/api/agent/*` 等）是为了在浏览器与内核之间挡一层；
 * 诊断端点不涉及业务数据、只返回部署事实，直接暴露给管理员是合适的，而且内核同样
 * 接受 session cookie（`SESSION_COOKIE_NAME`），不需要额外处理 token。
 */
import type { ProxyCheckResponse } from '@stackpanel/sdk';

/** 请求失败时带上状态码，面板据此区分「没登录」与「服务端异常」。 */
export class ProxyCheckRequestError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`proxy-check failed: HTTP ${status}`);
    this.name = 'ProxyCheckRequestError';
  }
}

/**
 * 内核的浏览器可达地址。
 *
 * 与 `publicApiBaseUrl()` 同源（`PUBLIC_API_BASE_URL`）：同源反代部署下就是当前站点
 * 的 origin，因此请求会真的经过反代，这正是我们要观测的对象。
 */
function kernelBaseUrl(): string {
  const configured = process.env['NEXT_PUBLIC_PUBLIC_API_BASE_URL'] ?? process.env['PUBLIC_API_BASE_URL'];
  if (configured) return configured.replace(/\/+$/, '');
  // 同源部署（推荐）：内核与页面在同一个 origin 下，直接请求相对路径。
  return '';
}

export async function proxyCheckFromBrowser(): Promise<ProxyCheckResponse> {
  const response = await fetch(`${kernelBaseUrl()}/api/v1/system/proxy-check`, {
    method: 'GET',
    // 必须带上 session cookie：端点是管理员权限。
    credentials: 'include',
    cache: 'no-store',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    // 这里不拼中文文案：面板会把它和翻译键一起渲染，写死中文会让其它语种混语言。
    // 只回「状态码 + 服务端原文」，由面板用自己的 i18n 包一层。
    const text = await response.text().catch(() => '');
    throw new ProxyCheckRequestError(response.status, text.slice(0, 200));
  }
  return (await response.json()) as ProxyCheckResponse;
}
