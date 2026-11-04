/**
 * 单端口模式（`STACKPANEL_SINGLE_PORT=1`）的路径归属判定。
 *
 * ## 为什么在 middleware 而不是 `next.config.ts` 的 `rewrites()`
 *
 * `rewrites()` 在 `next build` 时执行一次，结果被内联进
 * `.next/routes-manifest.json`。运行时改 `STACKPANEL_SINGLE_PORT` 没有任何效果 ——
 * 这个开关的全部意义就是「部署时决定」，所以必须在请求期求值的 middleware 里做。
 *
 * ## 为什么这个模式值得存在
 *
 * 事故的形态是：面板在站点配置里生成 `location ^~ / { include proxy/*.conf; }`，
 * 它会静默吞掉所有更"松"的匹配规则，于是「哪些前缀归内核」这一份手写清单只要漏
 * 一个、或者被面板覆盖，对应功能就 404，而页面完全正常。单端口模式把这份清单从
 * **部署配置**搬进**代码**：反代只需要一个 upstream，没有前缀可漏。
 *
 * ## 边界
 *
 * 只转发内核拥有的前缀；Web 自己的 BFF（`/api/account`、`/api/agent`、
 * `/api/notifications`、`/api/plugins`、`/api/store`、`/api/frontend-abi`、
 * `/api/action-flash`、`/api/admin`）必须留给文件路由系统，否则「登录、通知、
 * 插件后台」全部 404 —— 与事故的症状一模一样。
 */

/** 内核在根路径下拥有的前缀（`/api/v1/` 之外的那部分）。 */
export const KERNEL_ROOT_PREFIXES = [
  '/mcp',
  '/sp/',
  '/llm-gateway/',
  '/callbacks/',
  '/zjmf_api_login',
  '/cart/',
  '/host/',
  '/provision/',
  '/themes/',
  '/platform/',
] as const;

/** 内核在根路径拥有的精确路径（不能按前缀匹配，`/healthcheck` 不该被转走）。 */
export const KERNEL_ROOT_EXACT = ['/health', '/ready', '/version', '/plugins', '/media'] as const;

/** 内核的 API 版本前缀：**全部** `/api/v1/*` 路由都归内核。 */
export const KERNEL_API_PREFIX = '/api/v1/' as const;

/**
 * Web 自己的 BFF 前缀。单端口模式**必须**跳过它们，即使它们与内核前缀同层。
 *
 * 这份清单是「谁拥有 `/api/` 下不带 v1 的路径」的单一真源：`apps/web/src/app/api/`
 * 下每多一个目录就要多一行，`tests/single-port-rewrites.test.ts` 会对着文件系统
 * 核对，漏改测试即红。
 */
export const WEB_BFF_PREFIXES = [
  '/api/account/',
  '/api/action-flash',
  '/api/admin/',
  '/api/agent/',
  '/api/frontend-abi/',
  '/api/notifications',
  '/api/plugins/',
  // `/api/public/` 是同源代理（模型服务公开统计）：它是 Web 自己的路由，单端口
  // 模式下如果不在这里，请求会转给内核，然后 404。
  '/api/public/',
  '/api/store/',
] as const;

export type RouteOwner = 'kernel' | 'web';

/**
 * 判定一个请求路径在单端口模式下归谁。
 *
 * 顺序很重要：BFF 判定必须在 `/api/v1/` 之前 —— `/api/plugins/` 与
 * `/api/v1/...` 不冲突，但 `/api/admin/` 与未来的 `/api/v1/admin` 会，先判 Web
 * 的清单可以保证 Web 路由永远不会被内核抢走（内核抢走 = 登录后所有后台请求 404）。
 */
export function routeOwner(pathname: string): RouteOwner {
  for (const prefix of WEB_BFF_PREFIXES) {
    if (pathname === prefix || pathname === prefix.replace(/\/$/, '')) return 'web';
    if (pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)) return 'web';
  }
  if (pathname === '/api/v1' || pathname.startsWith(KERNEL_API_PREFIX)) return 'kernel';
  for (const exact of KERNEL_ROOT_EXACT) {
    if (pathname === exact) return 'kernel';
  }
  for (const prefix of KERNEL_ROOT_PREFIXES) {
    if (pathname === prefix.replace(/\/$/, '')) return 'kernel';
    if (pathname.startsWith(prefix)) return 'kernel';
  }
  return 'web';
}

/** middleware 需要转发的完整 URL；`web` 归属的路径返回 `null`。 */
export function kernelRewriteTarget(
  pathname: string,
  search: string,
  apiBaseUrl: string,
): URL | null {
  if (routeOwner(pathname) !== 'kernel') return null;
  const base = apiBaseUrl.replace(/\/+$/, '');
  // 路径原样保留：内核的路由表就是按 `/api/v1/...`、`/themes/...` 注册的，
  // 剥掉或改写前缀会全部 404。
  return new URL(`${base}${pathname}${search}`);
}

/** 运行期是否开启单端口模式。 */
export function singlePortEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = (env.STACKPANEL_SINGLE_PORT ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}
