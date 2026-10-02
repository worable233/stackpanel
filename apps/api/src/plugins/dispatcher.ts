import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  CorsPolicy,
  HttpMethod,
  HttpRequest,
  RawHttpReply,
  RawHttpRequest,
  RawRouteHandler,
  RouteAuth,
  RouteHandler,
} from '@stackpanel/sdk';
import { requireAuth, requirePermission, requireOpenScope } from './auth.ts';
import { rawBodyStream } from './body.ts';
import { normalizeErrorBody } from '../lib/problem.ts';
import { runIdempotent } from '../lib/idempotency.ts';
import { enforceTokenQuota } from '../lib/open-api-guard.ts';
import { invokeRouteHandler } from '../lib/route-handler.ts';

/** Open-platform metadata carried by a `/api/v1` alias route. */
export interface DispatcherOpenApi {
  capabilityId: string;
  mutating: boolean;
  /** Refined `资源:read|write` scope to enforce, when the capability declares one. */
  scope?: string;
}

/** A plugin route entry in the dispatcher's runtime route table. */
export interface DispatcherRoute {
  pluginId: string;
  method: HttpMethod;
  path: string;
  /** 'handler' = parsed JSON-style route; 'raw' = unparsed streaming passthrough. */
  kind: 'handler' | 'raw';
  auth?: RouteAuth;
  permission?: string;
  cors?: CorsPolicy | false;
  timeout?: number | false;
  bodyLimit?: number;
  handler: RouteHandler | RawRouteHandler;
  isActive: () => boolean;
  /** Present when the route is an open-platform alias (per-token quota + audit). */
  openApi?: DispatcherOpenApi;
}

export interface MatchResult {
  route: DispatcherRoute;
  params: Record<string, string>;
  literalCount: number;
}

/**
 * Runtime route dispatcher for plugin routes. Kernel routes remain native
 * Fastify routes (radix router gives them priority); plugin routes live in this
 * in-memory table and are served by catch-all `/*` handlers registered at boot.
 * Because the table can be mutated at runtime, newly installed/upgraded plugins
 * become live immediately without a restart.
 */
export class PluginDispatcher {
  private readonly routes: DispatcherRoute[] = [];
  /** Number of raw streaming handlers currently in flight (for graceful drain). */
  private rawInFlight = 0;
  private readonly rawDrained: Array<() => void> = [];

  /** Register a route and return a disposer that removes exactly that route. */
  register(route: DispatcherRoute): () => void {
    this.routes.push(route);
    return () => {
      const index = this.routes.indexOf(route);
      if (index >= 0) {
        this.routes.splice(index, 1);
      }
    };
  }

  /** Remove every route contributed by `pluginId` (used on upgrade/uninstall). */
  removeByPlugin(pluginId: string): void {
    for (let i = this.routes.length - 1; i >= 0; i -= 1) {
      if (this.routes[i]?.pluginId === pluginId) {
        this.routes.splice(i, 1);
      }
    }
  }

  /** All currently registered routes (used by the OpenAPI merge). */
  list(): readonly DispatcherRoute[] {
    return this.routes;
  }

  /** Open-platform alias routes (for docs/derivation), with their capability id. */
  listOpenApiRoutes(): readonly DispatcherRoute[] {
    return this.routes.filter((route) => route.openApi !== undefined);
  }

  /** Number of in-flight raw streaming responses. */
  get inFlightRaw(): number {
    return this.rawInFlight;
  }

  /**
   * Resolve once every in-flight raw stream has finished (or immediately when
   * none are active). Available to instrumentation/tests; graceful shutdown
   * races this against a grace window.
   */
  whenRawDrained(): Promise<void> {
    if (this.rawInFlight === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.rawDrained.push(resolve);
    });
  }

  /** Internal: called by the raw dispatch helper. */
  trackRawStart(): void {
    this.rawInFlight += 1;
  }

  /** Internal: called by the raw dispatch helper. */
  trackRawEnd(): void {
    this.rawInFlight -= 1;
    if (this.rawInFlight <= 0) {
      this.rawInFlight = 0;
      const pending = this.rawDrained.splice(0);
      for (const resolve of pending) resolve();
    }
  }

  /**
   * Best-match a method+path against the table. Literal (static) segments win
   * over `:param` captures; ties fall back to registration order.
   */
  match(method: string, pathname: string): MatchResult | null {
    let best: MatchResult | null = null;
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = matchPath(route.path, pathname);
      if (!params) continue;
      const literalCount = countLiteralSegments(route.path);
      if (!best || literalCount > best.literalCount) {
        best = { route, params, literalCount };
      }
    }
    return best;
  }

  /** Register the catch-all handlers (call last, after kernel routes). */
  install(app: FastifyInstance): void {
    app.get('/*', this.handle('GET'));
    app.post('/*', this.handle('POST'));
    app.put('/*', this.handle('PUT'));
    app.patch('/*', this.handle('PATCH'));
    app.delete('/*', this.handle('DELETE'));
    app.head('/*', this.handle('HEAD'));
    // OPTIONS is owned by @fastify/cors (global preflight). Per-route CORS for
    // raw routes is handled in the CORS phase, not here.
  }

  private handle(method: HttpMethod) {
    return async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
      const pathname = request.url.split('?')[0] as string;
      const match = this.match(method, pathname);
      if (!match) {
        return reply.code(404).send({ error: '资源不存在' });
      }
      if (!(await runGuards(match.route, request, reply))) {
        return reply;
      }
      if (match.route.cors) {
        writeCorsHeaders(match.route.cors, request, (name, value) => reply.header(name, value));
      }
      if (match.route.openApi) {
        // Open-platform alias: per-token quota first, then the refined scope
        // (when declared), then — for writes — the central idempotency contract,
        // then the plugin handler unchanged.
        await enforceTokenQuota(request, reply);
        if (reply.sent) return reply;
        if (match.route.openApi.scope) {
          await requireOpenScope(match.route.openApi.scope)(request, reply);
          if (reply.sent) return reply;
        }
        if (match.route.openApi.mutating) {
          await runIdempotent(request, reply, async () => {
            await invokeRouteHandler(
              match.route.handler as RouteHandler,
              request,
              reply,
              match.params,
            );
          });
          return reply;
        }
      }
      if (match.route.kind === 'raw') {
        await dispatchRaw(match.route, match.params, request, reply, this);
        return reply;
      }
      const req: HttpRequest = {
        params: match.params,
        query: request.query as Record<string, unknown>,
        body: request.body,
        headers: request.headers,
        ip: request.ip,
        ...(request.user
          ? {
              user: {
                id: request.user.id,
                email: request.user.email,
                role: request.user.permissions.has('platform.admin') ? 'ADMIN' : 'USER',
              },
            }
          : {}),
        ...(request.sessionToken ? { sessionToken: request.sessionToken } : {}),
      };
      const result = await (match.route.handler as RouteHandler)(req, reply);
      if (!reply.sent && !reply.raw.headersSent) {
        reply.send(result);
      }
      return reply;
    };
  }
}

/**
 * Hand a raw route full control of the native request/response. The kernel does
 * not parse, wrap, compress, or re-send; the plugin owns the socket until the
 * handler resolves (which is when a streaming response has finished).
 */
async function dispatchRaw(
  route: DispatcherRoute,
  params: Record<string, string>,
  request: FastifyRequest,
  reply: FastifyReply,
  dispatcherRef: PluginDispatcher,
): Promise<void> {
  const response = reply.raw;
  const queryIndex = request.url.indexOf('?');
  reply.hijack();

  if (route.cors) {
    writeCorsHeaders(route.cors, request, (name, value) => response.setHeader(name, value));
  }
  if (typeof route.timeout === 'number' && route.timeout > 0) {
    response.setTimeout(route.timeout, () => response.destroy());
  }

  const clientCloseListeners: Array<() => void> = [];
  let clientClosed = false;
  dispatcherRef.trackRawStart();

  const replyView: RawHttpReply = {
    status(code) {
      if (!response.headersSent) response.statusCode = code;
      return replyView;
    },
    header(name, value) {
      if (!response.headersSent) response.setHeader(name, value);
      return replyView;
    },
    write(chunk) {
      return response.write(chunk);
    },
    end(body) {
      response.end(body);
    },
    hijack() {
      // Already hijacked before invoking the handler.
    },
    onClientClose(fn) {
      clientCloseListeners.push(fn);
    },
    raw: response,
  };

  const requestView: RawHttpRequest = {
    method: request.method,
    url: request.url,
    params,
    query: new URLSearchParams(queryIndex >= 0 ? request.url.slice(queryIndex + 1) : ''),
    headers: request.headers,
    body: rawBodyStream(request),
    ip: request.ip,
    ...(request.user
      ? {
          user: {
            id: request.user.id,
            email: request.user.email,
            role: request.user.permissions.has('platform.admin') ? 'ADMIN' : 'USER',
          },
        }
      : {}),
    ...(request.sessionToken ? { sessionToken: request.sessionToken } : {}),
    raw: request.raw,
  };

  const onClientClose = (): void => {
    if (clientClosed) return;
    clientClosed = true;
    for (const fn of clientCloseListeners) {
      try {
        fn();
      } catch (error) {
        request.log.error(error);
      }
    }
  };
  request.raw.once('close', onClientClose);

  try {
    await (route.handler as RawRouteHandler)(requestView, replyView);
  } catch (error) {
    request.log.error(error);
    if (!response.headersSent) {
      response.statusCode = 500;
      response.setHeader('content-type', 'application/problem+json; charset=utf-8');
      response.end(
        JSON.stringify(
          normalizeErrorBody(500, { error: '服务器内部错误' }, {
            instance: request.url,
            requestId: request.id,
          }),
        ),
      );
    } else {
      response.destroy(error instanceof Error ? error : undefined);
    }
  } finally {
    request.raw.removeListener('close', onClientClose);
    dispatcherRef.trackRawEnd();
  }
}

/** Split a route path into segments, trimming empty leading/trailing parts. */
function segmentsOf(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

/** Number of literal (non-`:param`, non-`*`) segments in a route path. */
function countLiteralSegments(path: string): number {
  // Score specificity by total path depth plus literal count, so a deeper
  // literal route (e.g. `/llm-gateway/keys`) outranks a shallower wildcard
  // (`/llm-gateway/*`). Without the depth term both score 1 and the wildcard
  // — registered first — would swallow every sibling route.
  const segments = segmentsOf(path);
  return segments.length + segments.filter((s) => !s.startsWith(':') && s !== '*').length;
}

/**
 * Match a request pathname against a route path; capture `:params` and a
 * trailing `*` wildcard (into `params['*']`) or return null. Only a trailing
 * wildcard is supported; it also matches the bare prefix with an empty capture.
 */
function matchPath(routePath: string, pathname: string): Record<string, string> | null {
  const routeSegments = segmentsOf(routePath);
  const requestSegments = segmentsOf(pathname);
  const wildcard = routeSegments[routeSegments.length - 1] === '*';
  const fixedCount = wildcard ? routeSegments.length - 1 : routeSegments.length;
  if (
    wildcard ? requestSegments.length < fixedCount : routeSegments.length !== requestSegments.length
  ) {
    return null;
  }
  const params: Record<string, string> = {};
  for (let i = 0; i < fixedCount; i += 1) {
    const routeSegment = routeSegments[i] as string;
    const requestSegment = requestSegments[i] as string;
    if (routeSegment.startsWith(':')) {
      try {
        params[routeSegment.slice(1)] = decodeURIComponent(requestSegment);
      } catch {
        return null;
      }
    } else if (routeSegment !== requestSegment) {
      return null;
    }
  }
  if (wildcard) {
    params['*'] = requestSegments.slice(fixedCount).join('/');
  }
  return params;
}

/** Apply the isActive + auth guards; returns false when a reply was already sent. */
async function runGuards(
  route: DispatcherRoute,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  if (!route.isActive()) {
    await reply.code(404).send({ error: '资源不存在' });
    return false;
  }
  // A declared permission implies the route must be reachable only by an
  // authenticated user, even when the plugin did not set `auth` explicitly.
  if (route.auth === 'user' || route.auth === 'admin' || route.permission) {
    await requireAuth(request, reply);
    if (reply.sent) return false;
  }
  if (route.auth === 'admin') {
    await requirePermission('platform.admin')(request, reply);
    if (reply.sent) return false;
  }
  if (route.permission) {
    const user = request.user;
    if (!user) {
      await reply.code(401).send({ error: '未登录或会话已过期' });
      return false;
    }
    if (!user.permissions.has(route.permission)) {
      await reply.code(403).send({ error: '没有权限执行此操作' });
      return false;
    }
  }
  return true;
}

/**
 * Write per-route CORS headers. Kept independent of the global `@fastify/cors`
 * so a route can opt into a different policy (or a browser-facing gateway can
 * allow its own origins) without changing kernel-wide CORS.
 */
function writeCorsHeaders(
  policy: CorsPolicy,
  request: FastifyRequest,
  setHeader: (name: string, value: string) => void,
): void {
  const origin = request.headers.origin;
  const allowAny = policy.origins.includes('*');
  if (allowAny) {
    setHeader('access-control-allow-origin', policy.credentials ? (origin ?? '*') : '*');
  } else if (origin && policy.origins.includes(origin)) {
    setHeader('access-control-allow-origin', origin);
    setHeader('vary', 'Origin');
  } else {
    return;
  }
  if (policy.credentials) setHeader('access-control-allow-credentials', 'true');
  if (policy.methods?.length) setHeader('access-control-allow-methods', policy.methods.join(', '));
  if (policy.headers?.length) setHeader('access-control-allow-headers', policy.headers.join(', '));
  if (policy.maxAge !== undefined) setHeader('access-control-max-age', String(policy.maxAge));
}

declare module 'fastify' {
  interface FastifyInstance {
    pluginDispatcher: PluginDispatcher;
  }
}
