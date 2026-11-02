import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { AFFILIATE_COOKIE, normalizeAffiliateCode } from './lib/affiliate';
import { readCaptchaCspSources, type CaptchaCspSources } from './lib/captcha-csp';
import { sessionCookieName, sessionCookieSecure } from './lib/session-cookie';
import { kernelRewriteTarget, singlePortEnabled } from './lib/single-port';
import { DEFAULT_LOCALE, LOCALE_COOKIE, normalizeLocale } from './i18n/config';
import { translate } from './i18n/core';
import { negotiateLocale } from './i18n/negotiate';

const COOKIE_NAME = sessionCookieName();
const API_BASE_URL = process.env.API_BASE_URL ?? 'http://127.0.0.1:3001';
/** 会话核对的最长等待。超时按「问不到」处理（503），不按「未登录」处理。 */
const SESSION_CHECK_TIMEOUT_MS = 5_000;

/**
 * Referral attribution cookie. A visitor arriving on `?affid=<code>` keeps the
 * code so a later signup can be attributed to it. The Web layer only stores and
 * forwards the code — it never validates or redeems it; the owning plugin
 * decides whether the code is real.
 */
const AFFILIATE_COOKIE_MAX_AGE = Number(process.env.AFFILIATE_COOKIE_DAYS ?? 30) * 86_400;

/** The API origin, allowed for cross-origin styles/images/connections. */
function apiStyleOrigin(): string {
  try {
    const url = new URL(API_BASE_URL);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : '';
  } catch {
    return '';
  }
}

const API_ORIGIN = apiStyleOrigin();

/**
 * Build the per-request Content-Security-Policy (security audit L-2).
 *
 * Production: inline scripts are allowed only via a fresh per-request nonce plus
 * `'strict-dynamic'` — there is no `script-src 'unsafe-inline'` fallback. Next.js
 * reads the nonce back out of the request `Content-Security-Policy` header and
 * applies it to its own scripts and inline bootstrap data, so no tag needs a
 * manual nonce. Verified against a real `next build` + `next start`: every
 * emitted `<script src>` carries the nonce, so `'strict-dynamic'` does not
 * discard the client chunks.
 *
 * Development: a nonce-bearing `'strict-dynamic'` policy makes the SSR shell
 * completely inert. The dev renderer emits its Flight/bootstrap inline scripts
 * without the request nonce, and under `'strict-dynamic'` the nonce also
 * disables host allowlisting for same-origin `<script src>` chunks. The result
 * is HTML that renders but whose buttons, menus, search, notifications and
 * avatar do nothing, with no useful console error. Dev therefore allows the
 * dev server's own inline bootstrap and chunks explicitly. This is dev-only:
 * `isDev` is derived from `NODE_ENV === 'development'`, so a production build
 * always gets the nonce policy below. Regression coverage lives in
 * `tests/contract05-csp.test.ts`.
 *
 * Inline *styles* keep `'unsafe-inline'` in both modes because React and UI
 * libraries legitimately emit `style` attributes, which nonces cannot cover
 * without `'unsafe-hashes'` on every attribute.
 */
/** Exported for the contract-05 CSP regression test. */
export function buildCsp(
  nonce: string,
  isDev: boolean,
  captcha: Partial<CaptchaCspSources> = {},
): string {
  // Sources arrive from the kernel over HTTP, so a partially-shaped payload must
  // degrade to the pre-captcha policy instead of throwing inside the proxy.
  const sources: CaptchaCspSources = {
    script: captcha.script ?? [],
    style: captcha.style ?? [],
    frame: captcha.frame ?? [],
    connect: captcha.connect ?? [],
    worker: captcha.worker ?? [],
  };
  // A challenge widget's own script is loaded by a Next chunk, which carries the
  // per-request nonce, so `'strict-dynamic'` already trusts the injected
  // `<script src>` in production — no vendor host belongs in `script-src` there,
  // and adding one would only dilute the policy (host-sources are ignored once
  // `'strict-dynamic'` is present). Dev has no `'strict-dynamic'`, so the origin
  // must be named explicitly or the widget never loads.
  const scriptSrc = isDev
    ? // Dev-only: Next's own inline bootstrap is emitted without the nonce, and
      // `'strict-dynamic'` would additionally drop same-origin chunks.
      `script-src 'self' 'unsafe-inline' 'unsafe-eval'${hosts(sources.script)}`
    : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`;

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "form-action 'self'",
    // Without an explicit `frame-src` the widget iframe falls back to
    // `default-src 'self'` and is blocked. Declaring it keeps the fallback for
    // every other frame while letting the provider name its own origins.
    `frame-src 'self'${hosts(sources.frame)}`,
    `img-src 'self' data: blob:${API_ORIGIN ? ` ${API_ORIGIN}` : ''}`,
    "font-src 'self' data:",
    // A widget may inject its own theme stylesheet; without the origin the control
    // renders unstyled (or invisible) while the challenge itself still works.
    `style-src 'self' 'unsafe-inline'${API_ORIGIN ? ` ${API_ORIGIN}` : ''}${hosts(sources.style)}`,
    // Proof-of-work widgets (`new Worker(URL.createObjectURL(blob))`) need a blob
    // worker. `blob:` is declared only when a provider actually asks for a worker
    // or script source, so a deployment with no captcha keeps its previous policy
    // exactly. Deduplicated because a provider may name `blob:` itself.
    ...(sources.worker.length > 0 || sources.script.length > 0
      ? [`worker-src ${["'self'", ...new Set(['blob:', ...sources.worker])].join(' ')}`]
      : []),
    scriptSrc,
    // The widget's script posts its solution back to the challenge origin.
    `connect-src 'self'${API_ORIGIN ? ` ${API_ORIGIN}` : ''}${isDev ? ' ws: wss:' : ''}${hosts(sources.connect)}`,
  ].join('; ');
}

/** Render origins as CSP host-source values, or nothing when the list is empty. */
function hosts(origins: readonly string[] | undefined): string {
  if (!origins || origins.length === 0) return '';
  return ` ${origins.join(' ')}`;
}

/**
 * Next.js 16 proxy (replaces the legacy `middleware` convention).
 *
 * Two responsibilities, in order:
 *  1. Generate a per-request CSP nonce and attach it to the request (so Next.js
 *     can inject it into its scripts) and the response.
 *  2. First-line admin gate for `/admin` — every Fastify endpoint re-checks
 *     permissions, this only avoids rendering the shell for anonymous callers.
 *
 * Sessions are server-side, so the gate asks the kernel `/auth/session` instead
 * of decoding a JWT: no/invalid session -> `/login`, non-admin -> 403.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  // Cached inside `readCaptchaCspSources`; empty when no provider is installed,
  // which makes the policy identical to the pre-captcha implementation.
  const captchaSources = await readCaptchaCspSources();
  const csp = buildCsp(nonce, process.env.NODE_ENV === 'development', captchaSources).replace(
    "frame-ancestors 'none'",
    request.nextUrl.pathname === '/preview' ? "frame-ancestors 'self'" : "frame-ancestors 'none'",
  );

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set(
    'x-stackpanel-request-path',
    request.nextUrl.pathname + request.nextUrl.search,
  );
  requestHeaders.set('Content-Security-Policy', csp);

  /**
   * 标记 server action 请求。
   *
   * Next 的 server action 以 `POST <当前页面 URL>` 发送（带 `Next-Action` 头），
   * 所以反代/容器日志里它和普通页面请求一模一样：`POST /admin/plugin/x/connections`
   * 看起来就像有人打开了那个页面。排查「到底是页面渲染还是业务提交失败了」
   * 时，这一点非常要命——本次就是靠翻 OpenResty 日志逐条对时间才看出来的。
   *
   * 这里给这类请求打上一个可搜索的标记：
   *   - 响应头 `x-stackpanel-request-kind: action|page`（日志与浏览器面板都看得到）
   *   - 环境变量 `STACKPANEL_ACCESS_LOG_ACTIONS=1` 时额外在 stdout 打一行，
   *     适合看不到响应头的反代（或根本没有日志采集）的部署。
   */
  const isServerAction = request.headers.has('next-action') || request.headers.has('Next-Action');

  const { pathname } = request.nextUrl;

  /**
   * 每个响应都带上请求类型，让“页面渲染”和“业务提交”在日志里可区分。
   *
   * 抽成独立函数是因为**两条返回路径**都要经过它：普通页面（`withAffiliate`）
   * 和单端口模式的 kernel rewrite。只挂在其中一条上，单端口部署就还是瞎的。
   */
  const markRequestKind = <T extends NextResponse>(response: T): T => {
    response.headers.set('x-stackpanel-request-kind', isServerAction ? 'action' : 'page');
    if (isServerAction && process.env['STACKPANEL_ACCESS_LOG_ACTIONS'] === '1') {
      // 只能看到 stdout 的部署（大多数反代/容器默认如此）靠这一行定位。
      console.log(
        `[action] ${request.method} ${pathname}${request.nextUrl.search}` +
          ` ua=${request.headers.get('user-agent') ?? '-'}`,
      );
    }
    return response;
  };

  // 单端口模式：内核拥有的前缀在这里转发。放在 CSP/nonce 之后、前台/后台门禁
  // 之前 —— 这些路径本来就不是页面，不需要 nonce 也不需要登录门禁（内核自己
  // 有鉴权）。见 src/lib/single-port.ts 说明为什么不能在 next.config.ts 里做。
  if (singlePortEnabled()) {
    const target = kernelRewriteTarget(pathname, request.nextUrl.search, API_BASE_URL);
    if (target) {
      // `NextResponse.rewrite` 会重新走一遍路由解析，但不会再进 middleware
      // （目标 URL 的 host 与本站不同），所以不会无限递归。
      const rewritten = NextResponse.rewrite(target, { request: { headers: requestHeaders } });
      rewritten.headers.set('Content-Security-Policy', csp);
      return markRequestKind(rewritten);
    }
  }

  // Capture `?affid=` on any landing page. First click wins: an existing
  // attribution cookie is never overwritten, so a second code cannot steal a
  // visitor who already arrived through someone else's link.
  const affid = normalizeAffiliateCode(request.nextUrl.searchParams.get('affid'));
  const shouldSetAffiliate = affid !== null && !request.cookies.get(AFFILIATE_COOKIE)?.value;

  const withAffiliate = <T extends NextResponse>(response: T): T => {
    markRequestKind(response);
    response.headers.set('X-Frame-Options', pathname === '/preview' ? 'SAMEORIGIN' : 'DENY');
    if (shouldSetAffiliate && affid) {
      response.cookies.set(AFFILIATE_COOKIE, affid, {
        httpOnly: true,
        sameSite: 'lax',
        secure: sessionCookieSecure({
          forwardedProto: request.headers.get('x-forwarded-proto'),
        }),
        path: '/',
        maxAge: AFFILIATE_COOKIE_MAX_AGE,
      });
    }
    return response;
  };

  // Non-admin routes: skip the kernel round-trip, just carry the nonce.
  if (!pathname.startsWith('/admin')) {
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set('Content-Security-Policy', csp);
    return withAffiliate(response);
  }

  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (!token) {
    return withAffiliate(NextResponse.redirect(new URL('/login', request.url)));
  }
  try {
    const res = await fetch(`${API_BASE_URL}/auth/session`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      cache: 'no-store',
      // 内核不可用时不要让请求悬着：超时按 5xx 处理（见下方 catch 的 nil 分支）。
      signal: AbortSignal.timeout(SESSION_CHECK_TIMEOUT_MS),
    });
    // 5xx：内核自己出问题了，不能据此判定会话无效。
    //
    // 这里以前不区分状态码：只要 body 里没有 `user` 就 `redirect('/login')`。
    // 于是 api 重启、数据库连接池打满、或反代回 502 的几十秒里，所有已登录
    // 管理员都被踢出后台——他们的会话完全正常。重定向还会丢掉正在提交的表单。
    if (res.status >= 500) return withAffiliate(serviceUnavailable(request, csp));
    const body = (await res.json().catch(() => null)) as {
      user?: { role?: string } | null;
    } | null;
    if (!res.ok && !body) {
      // 无法解析的 4xx：会话真的不认了。
      return withAffiliate(NextResponse.redirect(new URL('/login', request.url)));
    }
    const user = body?.user ?? null;
    if (!user) {
      return withAffiliate(NextResponse.redirect(new URL('/login', request.url)));
    }
    if (user.role !== 'ADMIN') {
      return withAffiliate(new NextResponse('Forbidden', { status: 403 }));
    }
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set('Content-Security-Policy', csp);
    return withAffiliate(response);
  } catch {
    // 网络失败 / 超时：同样是“问不到”，不是“未登录”。
    return withAffiliate(serviceUnavailable(request, csp));
  }
}

/**
 * 内核暂时答不上来时的 503 页面。
 *
 * 故意**不**重定向：重定向会把用户扔到一个看起来像“掉登录”的页面，而他其实
 * 仍然登录着。保留原地址，刷新即继续。
 */
function serviceUnavailable(request: NextRequest, csp: string): NextResponse {
  // 文案走消息目录，不硬编码：这是给用户看的界面文案（ADR-0016）。
  // middleware 里拿不到 `next/headers`，所以用同一套纯函数直接协商：
  // cookie → Accept-Language → 默认语言，与 `getLocale()` 的优先级一致。
  const saved = request.cookies.get(LOCALE_COOKIE)?.value;
  const locale = saved
    ? normalizeLocale(saved)
    : negotiateLocale(request.headers.get('accept-language'), undefined, DEFAULT_LOCALE);
  const escape = (value: string): string =>
    value.replace(/[&<>"']/g, (ch) =>
      ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;',
    );
  const title = escape(translate(locale, 'common.serviceUnavailableTitle'));
  const hint = escape(translate(locale, 'common.serviceUnavailableHint'));
  const retry = escape(translate(locale, 'common.retry'));
  const html =
    `<!doctype html><meta charset="utf-8"><title>503</title>` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<div style="font:15px/1.6 system-ui,sans-serif;max-width:32rem;margin:20vh auto;padding:0 1.5rem">` +
    `<h1 style="font-size:1.1rem;margin:0 0 .6rem">${title}</h1>` +
    `<p style="margin:0 0 1rem;color:#666">${hint}</p>` +
    `<a href="" style="color:inherit">${retry}</a></div>`;
  const response = new NextResponse(html, {
    status: 503,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  /*
   * Run on every page route so the nonce reaches the renderer, but skip Next
   * static/image assets and link prefetches (which do not need a CSP and would
   * otherwise waste a nonce).
   *
   * `/api/` is **not** excluded: single-port mode has to forward the kernel's
   * `/api/v1/*` from here (`rewrites()` is resolved at build time, so it cannot
   * serve this). Web's own BFF handlers stay out of the way because
   * `kernelRewriteTarget` returns `null` for them; the extra middleware pass costs
   * one function call for local routes.
   */
  matcher: [
    {
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
