/**
 * API versioning + deprecation policy (CONTRACT-SEC / G1).
 *
 * 版本策略
 * --------
 * - `/api/v1/**`（开放平台）是**对外承诺的稳定契约**：同一 major 内只允许
 *   **增量**变更（新增能力项、新增可选字段/查询参数）。破坏性变更必须开新
 *   major（`/api/v2`）并给出弃用窗口，禁止原地改语义（ADR-0001 的传输适配原则）。
 * - 内核内部路由（`/admin/**`、`/me/**` 等）面向自家前端，版本策略更宽松，但
 *   删除/改名仍应经由本文件的弃用登记，让调用方有机会迁移。
 *
 * 弃用机制
 * --------
 * 任何即将下线或已改道的路由，在 {@link DEPRECATED_ROUTES} 登记一条声明。命中时
 * 内核统一补标准弃用响应头（RFC 8594 + `Deprecation` 草案）：
 *
 *   Deprecation: true
 *   Sunset: <HTTP-date>                       （如给出 sunsetAt）
 *   Link: <replacement>; rel="deprecation"    （如给出 replacement）
 *
 * 这些头是纯附加信息，不改变状态码与响应体，旧客户端可继续工作直到 `Sunset`。
 *
 * 接线（单写者 KERNEL）：在 `app.ts` 的 `onSend` 之前调用一次
 * `registerApiVersioning(app)`；当前尚无已弃用路由，登记表为空时该 hook 为 no-op。
 *
 * 版本常量（`KERNEL_API_VERSION` / `API_VERSION` / `OPEN_API_NAMESPACE`）自
 * SPEC-SDK / D15 起由契约包 `@stackpanel/spec` 单一提供；本文件保留内核侧入口。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { HttpMethod } from '@stackpanel/sdk';
import { API_VERSION, OPEN_API_NAMESPACE } from '@stackpanel/spec';

export { API_VERSION, OPEN_API_NAMESPACE };

/** One declared deprecation for a concrete method + path template. */
export interface DeprecatedRoute {
  method: HttpMethod;
  /** Path template exactly as registered (e.g. `/admin/legacy/:id`). */
  path: string;
  /** ISO date this route was marked deprecated (for the `Deprecation` header note). */
  since: string;
  /** ISO date after which the route may be removed → `Sunset` (HTTP-date). */
  sunsetAt?: string;
  /** Callers should migrate to this path/URL → `Link rel="deprecation"`. */
  replacement?: string;
  /** Short operator-facing rationale (not sent on the wire). */
  note?: string;
}

/**
 * The deprecation registry. Empty by contract until the first route is retired;
 * adding an entry is the *only* supported way to announce a deprecation.
 */
export const DEPRECATED_ROUTES: readonly DeprecatedRoute[] = [];

/** Literal-segment path matcher with `:param` capture, mirroring capability matching. */
function pathTemplateMatches(template: string, pathname: string): boolean {
  const a = template.split('/').filter(Boolean);
  const b = pathname.split('/').filter(Boolean);
  if (a.length !== b.length) return false;
  return a.every((segment, i) => segment.startsWith(':') || segment === b[i]);
}

/** Find the deprecation (if any) declared for a concrete request. */
export function deprecationFor(
  method: string,
  pathname: string,
  registry: readonly DeprecatedRoute[] = DEPRECATED_ROUTES,
): DeprecatedRoute | undefined {
  const normalized = pathname.split('?')[0] ?? pathname;
  return registry.find(
    (entry) => entry.method === method.toUpperCase() && pathTemplateMatches(entry.path, normalized),
  );
}

/**
 * Apply the standard deprecation headers to a reply. Exported for direct unit
 * testing and for callers that render their own responses.
 */
export function applyDeprecationHeaders(reply: FastifyReply, entry: DeprecatedRoute): void {
  reply.header('Deprecation', 'true');
  if (entry.sunsetAt) {
    const parsed = new Date(entry.sunsetAt);
    if (!Number.isNaN(parsed.getTime())) reply.header('Sunset', parsed.toUTCString());
  }
  if (entry.replacement) {
    reply.header('Link', `<${entry.replacement}>; rel="deprecation"`);
  }
}

/**
 * Register the global deprecation hook. no-op unless at least one route is
 * declared, so this is safe to wire before the registry is ever populated.
 */
export function registerApiVersioning(
  app: FastifyInstance,
  registry: readonly DeprecatedRoute[] = DEPRECATED_ROUTES,
): void {
  if (registry.length === 0) return;
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const entry = deprecationFor(request.method, request.url, registry);
    if (entry) applyDeprecationHeaders(reply, entry);
  });
}
