/**
 * Kernel admin route → open-platform capability aliases.
 *
 * The open platform's promise is "everything the platform can do, an agent can
 * do — within the credential's permissions" (ADR-0001). Kernel admin routes
 * (`/admin/*`) were previously reachable only by a browser session, so ~80
 * operations (users, settings, plugins, RBAC, audit, currency, jobs, …) had no
 * capability at all: `/api/v1/capabilities` and MCP `tools/list` simply did not
 * mention them, and the kernel Agent could not touch them.
 *
 * This module closes that gap **without** a second implementation. The single
 * source of truth is {@link ADMIN_CAPABILITIES} in `capability-registry.ts`,
 * declared exactly like every other capability (with the public
 * `/api/v1/admin/*` path). Everything else derives from it:
 *
 *   - `/api/v1/capabilities`, the OpenAPI doc and MCP `tools/list` see it as a
 *     normal capability;
 *   - this module re-registers the *same* `handler` and `preHandler` chain the
 *     admin route already declared at the mirrored public path.
 *
 * An alias can therefore never be *wider* than the route it mirrors: the coarse
 * `requireRole('ADMIN')` runs first and unchanged, so a token whose owner is not
 * an admin is rejected by the original guard no matter what scope it carries.
 * Only then does the open-platform layer narrow it further — refined scope
 * (`资源:read|write`, which a token must carry *exactly*), quota, idempotency.
 *
 * ## Why `onRoute`
 *
 * Admin routes are registered as separate Fastify sub-plugins across `buildApp`,
 * each with its own guard. Capturing `onRoute` mirrors them generically without
 * threading a registry through 18 modules, and keeps the mirrored chain
 * byte-identical to the original.
 */
import type { FastifyInstance, RouteHandlerMethod, RouteOptions } from 'fastify';
import { isRoleGuard, requireAuth, requireOpenScope } from '../plugins/auth.ts';
import { enforceTokenQuota } from './open-api-guard.ts';
import { runIdempotent } from './idempotency.ts';
import { adminCapabilityByRoute, adminInternalPathOf } from './capability-registry.ts';

/** Internal `/admin/...` path mirrored by a public `/api/v1/admin/...` one. */
export { adminInternalPathOf };

/**
 * Reduce a route's own guard chain for the alias.
 *
 * Every admin module declares the identical pair — `[requireAuth,
 * requireRole('ADMIN')]` — and `requireRole('ADMIN')` is exactly
 * `permissions.has('platform.admin')` (its implementation rewrites the role to
 * the `platform.admin` permission key). Keeping it verbatim would make every
 * refined scope unusable on its own: a token holding `settings:read` but not the
 * coarse `platform.admin` would be rejected before the refined scope is even
 * consulted, so `settings:read|write` could never narrow anything.
 *
 * The coarse requirement is therefore not dropped but *deferred* to
 * {@link requireOpenScope}: a session caller is admitted when their permissions
 * satisfy the scope's resource, and `KERNEL_RESOURCE_PERMISSIONS` maps every
 * admin resource to `platform.admin` — so an admin session still passes and
 * nobody else gains anything. Token callers must carry the refined scope
 * *exactly*, which is strictly narrower than the coarse key.
 *
 * A role guard is recognised by the marker `requireRole` stamps on its closure
 * (`ROLE_GUARD`), not by identity or by matching a function's source text.
 * Any other guard a route declares is preserved untouched.
 */
type Guard = (request: never, reply: never) => unknown;

function openGuardChain(inherited: readonly unknown[]): Guard[] {
  return inherited.filter(
    (guard) => !isRoleGuard(guard) && guard !== (requireAuth as unknown),
  ) as Guard[];
}

/**
 * Install the alias builder on `app`.
 *
 * Must be called **before** any admin route is registered so the `onRoute` hook
 * observes them all. Aliases are registered on a microtask: Fastify forbids
 * calling `route()` while it is still emitting `onRoute`.
 */
export function installAdminCapabilityAliases(app: FastifyInstance): void {
  if (adminCapabilityByRoute().size === 0) return;

  const registered = new Set<string>();

  app.addHook('onRoute', (route: RouteOptions) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      // Fastify auto-generates a HEAD for every GET; mirroring it would collide
      // with the alias's own auto-generated HEAD.
      if (method === 'HEAD') continue;
      const capability = adminCapabilityByRoute().get(`${method} ${route.url}`);
      if (!capability) continue;

      if (registered.has(`${method} ${capability.path}`)) continue;
      registered.add(`${method} ${capability.path}`);

      const original = route.preHandler;
      const inherited = original === undefined ? [] : Array.isArray(original) ? original : [original];
      // Open-platform layer, applied after the route's own guard: per-token
      // quota, then the refined scope. A copy keeps the original array intact.
      const preHandler = [
        requireAuth,
        ...openGuardChain(inherited),
        enforceTokenQuota,
        requireOpenScope(capability.scope ?? ''),
      ] as never;
      const handler = route.handler as unknown as RouteHandlerMethod;

      queueMicrotask(() => {
        try {
          app.route({
            method,
            url: capability.path,
            preHandler,
            handler: capability.mutating
              ? async (request, reply) => {
                  await runIdempotent(request, reply, async () => {
                    await handler.call(app, request, reply);
                  });
                  return reply;
                }
              : handler,
          });
        } catch (error) {
          // eslint-disable-next-line no-console
          app.log.error(
            `[capability-alias] 无法挂载 ${capability.id} → ${capability.path}: ${String(error)}`,
          );
        }
      });
    }
  });
}
