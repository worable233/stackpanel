/**
 * 同源判定 —— Web BFF 与内核共用的**唯一**实现。
 *
 * 为什么必须共用：这套判定同时决定两件事
 *   1. Web BFF 要不要接受这个 cookie 认证的写请求（`apps/web/src/lib/request-origin.ts`）；
 *   2. 诊断端点 `/api/v1/system/proxy-check` 报「originGuardWouldPass」是真还是假。
 *
 * 一旦两处各写一份，就会出现最坏的结果：**诊断说通过，真实请求仍然 403**。那比
 * 没有诊断更糟 —— 运维会顺着错误的结论去改反代，越改越乱。
 *
 * 事故背景（0.1.1 线上）：CDN / 面板终止 TLS、回源走 http 时，反代若用 `$scheme`
 * 填 `X-Forwarded-Proto`，它会固定是 `http`，而浏览器 `Origin` 是 `https://…`。
 * 判定失配 → 403，界面文案「请求来源无效」，后台所有 POST 失效（GET 不受影响，
 * 所以页面看着完全正常）。
 */

/** 只依赖 `get`，所以浏览器 `Headers`、Fastify 头对象、普通 Map 都能传。 */
export interface HeaderBag {
  get(name: string): string | null;
}

/** 取逗号分隔头的第一个值（`a, b` → `a`）。空串归一为 `undefined`。 */
export function firstHeaderValue(value: string | null | undefined): string | undefined {
  return value?.split(',')[0]?.trim() || undefined;
}

function toBag(headers: HeaderBag | Record<string, string | string[] | undefined>): HeaderBag {
  if (typeof (headers as HeaderBag).get === 'function') return headers as HeaderBag;
  const bag = headers as Record<string, string | string[] | undefined>;
  return {
    get(name: string): string | null {
      const value = bag[name] ?? bag[name.toLowerCase()] ?? bag[name.toUpperCase()];
      if (value === undefined) return null;
      return Array.isArray(value) ? (value[0] ?? null) : value;
    },
  };
}

/**
 * 判定一个 cookie 认证的写请求是否同源。
 *
 * 不用 `request.nextUrl.origin`：Next 会把它归一化成 dev server 配置的 host，只要
 * 访客从另一个名字进来（`127.0.0.1` 与 `localhost`、LAN 地址、反代的公网域名），
 * 它就和浏览器的 `Origin` 不一致，导致合法请求被 403。
 *
 * 用请求自己的 `Host`（浏览器实际连的那个）作为权威，`X-Forwarded-Host` 优先。
 * 反代报的协议必须与 `Origin` 的 scheme 一致 —— TLS 终止在应用前面就是这个判定的
 * 主要用途。
 */
export function isSameOriginRequest(request: { headers: HeaderBag }): boolean;
export function isSameOriginRequest(request: {
  headers: Record<string, string | string[] | undefined>;
}): boolean;
export function isSameOriginRequest(request: {
  headers: HeaderBag | Record<string, string | string[] | undefined>;
}): boolean {
  const headers = toBag(request.headers);
  const origin = headers.get('origin');
  // 浏览器在非 GET/HEAD 上一定带 `Origin`；不带的调用方不是浏览器的正常表单/fetch。
  if (!origin) return false;
  const host = firstHeaderValue(headers.get('x-forwarded-host')) ?? headers.get('host');
  if (!host) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.host !== host) return false;
  const proto = firstHeaderValue(headers.get('x-forwarded-proto'));
  if (proto && url.protocol !== `${proto}:`) return false;
  return true;
}

/**
 * 同源判定的**逐项分解**，供 `/api/v1/system/proxy-check` 与后台诊断面板使用。
 *
 * 为什么不复用 `isSameOriginRequest` 的布尔结果直接报「失败」：运维需要知道
 * **哪一项**不匹配。`host` 不匹配是 Host 头问题，`proto` 不匹配是协议透传问题，
 * 两者的修复动作完全不同（前者查 `proxy_set_header Host`，后者查
 * `X-Forwarded-Proto`）。
 */
export interface OriginCheckBreakdown {
  /** 请求带了吗 —— 浏览器非 GET 请求一定带。 */
  hasOrigin: boolean;
  /** 解析后的 `Origin`（解析失败时为 null）。 */
  origin: string | null;
  /** 用于比对的 host（`X-Forwarded-Host` 优先，退回 `Host`）。 */
  host: string | null;
  /** 反代报的协议（未报时为 null）。 */
  forwardedProto: string | null;
  /** `Origin` 里的 scheme（如 `https`）。 */
  originProto: string | null;
  hostMatches: boolean;
  /** 未报协议时视为通过（与 {@link isSameOriginRequest} 行为一致）。 */
  protoMatches: boolean;
  /** 最终结论，恒等于 `isSameOriginRequest`。 */
  passes: boolean;
}

export function checkOrigin(request: {
  headers: HeaderBag | Record<string, string | string[] | undefined>;
}): OriginCheckBreakdown {
  const headers = toBag(request.headers);
  const originHeader = headers.get('origin');
  const host = firstHeaderValue(headers.get('x-forwarded-host')) ?? headers.get('host');
  const forwardedProto = firstHeaderValue(headers.get('x-forwarded-proto')) ?? null;

  let origin: URL | null = null;
  if (originHeader) {
    try {
      origin = new URL(originHeader);
    } catch {
      origin = null;
    }
  }

  const originProto = origin?.protocol.replace(/:$/, '') ?? null;
  const hostMatches = Boolean(origin && host && origin.host === host);
  const protoMatches = !forwardedProto || (originProto !== null && originProto === forwardedProto);

  return {
    hasOrigin: Boolean(originHeader),
    origin: originHeader ?? null,
    host,
    forwardedProto,
    originProto,
    hostMatches,
    protoMatches,
    passes: isSameOriginRequest({ headers }),
  };
}
