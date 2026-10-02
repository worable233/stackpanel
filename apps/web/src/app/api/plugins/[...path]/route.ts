import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { ApiError } from '@stackpanel/sdk';
import { getBffPluginClient } from '@/lib/plugins-bff';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';

export const dynamic = 'force-dynamic';

/**
 * 通用插件 BFF 代理（KERNEL）。
 *
 * 插件前端在浏览器里运行，拿不到会话令牌，也不能直接访问内核 `:3001`。内核
 * 因此提供**唯一一条**认证转发路由，取代过去「一个插件一套专属代理」的写法：
 *
 *   /api/plugins/<path>  →  {API_BASE_URL}/<path>
 *
 * **关键**：内核插件路由挂载在其声明的**绝对路径**上，插件 id 并不是路径前缀
 * （如 store 声明 `/store/admin/orders`、catalog 声明 `/catalog/admin/categories`、
 * llm-gateway 声明 `/llm-gateway/admin/upstream-models`）。所以本路由把
 * `/api/plugins` 之后的整段原样拼接，插件 id 只用于**观测**（例如
 * `/api/plugins/catalog/admin/categories` → `/catalog/admin/categories`）。
 *
 * 鉴权：转发携带当前会话令牌（cookie `sp_session`）。匿名时不带令牌，由内核返回
 * 401，本路由把状态码与响应体原样透传，浏览器端据此判定「未登录」——不再把 401
 * 误报成 500。
 *
 * 边界：只做认证转发，不解析、不缓存、不重试（韧性由底层 transport 负责）。方法、
 * 查询串、请求体、响应体与状态码均原样往返。二进制响应（图片等）以 `arrayBuffer`
 * 透传，不做文本转换。
 *
 * 边界校验：转发路径必须是**多段**且首段合法（`[a-z0-9_-]+`），因此
 * `/api/plugins/foo` 是可转发的，而 `/api/plugins` 本身没有可代理的插件路径。
 *
 * 这是**唯一**的插件 BFF 出口：新增插件不应再往内核添加专属代理路由。
 */
const UPSTREAM_TIMEOUT_MS = 30_000;

/** 转发路径首段（插件命名空间）的形状；与内核 `PLUGIN_ID_PATTERN` 对齐。 */
const PLUGIN_NAMESPACE_PATTERN = /^[a-z0-9_-]{1,64}$/;

/** 不转发到上游的逐跳请求头（RFC 9110 §7.6.1）。 */
const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-authorization',
  'proxy-authenticate',
  'content-length',
]);

/** 不转发回浏览器的逐跳响应头。 */
const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-authenticate',
  'content-encoding',
  'content-length',
]);

interface RouteContext {
  params: Promise<{ path?: string[] }>;
}

async function proxy(request: NextRequest, context: RouteContext): Promise<Response> {
  const t = createTranslator(await getLocale());
  const { path: segments } = await context.params;

  if (!segments || segments.length === 0 || !PLUGIN_NAMESPACE_PATTERN.test(segments[0] ?? '')) {
    return NextResponse.json({ error: t('api.invalidParams') }, { status: 400 });
  }

  const upstreamPath = `/${segments.join('/')}`;
  const searchParams = request.nextUrl.searchParams.toString();
  const search = searchParams ? `?${searchParams}` : '';
  const target = `${process.env.API_BASE_URL ?? 'http://127.0.0.1:3001'}${upstreamPath}${search}`;

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: 'manual',
    cache: 'no-store',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  };
  if (hasBody) {
    init.body = await request.arrayBuffer();
  }

  try {
    const api = await getBffPluginClient();
    const response = await fetch(target, {
      ...init,
      ...(api.token
        ? {
            headers: {
              ...Object.fromEntries(headers),
              authorization: `Bearer ${api.token}`,
            },
          }
        : {}),
    });

    const responseHeaders = new Headers();
    response.headers.forEach((value, key) => {
      if (!HOP_BY_HOP_RESPONSE_HEADERS.has(key.toLowerCase())) responseHeaders.set(key, value);
    });
    return new Response(await response.arrayBuffer(), {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json(
        { error: error.message, code: error.code, status: error.status },
        { status: error.status },
      );
    }
    return NextResponse.json({ error: t('api.notificationsUnavailable') }, { status: 502 });
  }
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const HEAD = proxy;
