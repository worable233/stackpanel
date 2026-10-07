import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import { InfraConfigError, type RedisClient } from '@stackpanel/db';
import { isPluginError, REDIS_KEY_PREFIX, type PluginRoute } from '@stackpanel/sdk';
import { KERNEL_VERSION } from '@stackpanel/spec';
import { env } from './config/env.ts';
import { buildProblem, normalizeErrorBody } from './lib/problem.ts';
import { CAPABILITIES } from './lib/capability-registry.ts';
import { toOpenApiOperation, toOpenApiPath } from './lib/openapi-contract.ts';
import { registerApiVersioning } from './lib/api-version.ts';
import { recordTokenUsage } from './lib/open-api-guard.ts';
import { seedDefaultBrand } from './lib/platform-brand.ts';
import { PluginDispatcher } from './plugins/dispatcher.ts';
import { installBodyRouting } from './plugins/body.ts';
import { extractSession } from './plugins/auth.ts';
import { ExtensionService } from './extensions/service.ts';
import { installExtensionRoutes } from './extensions/routes.ts';
import { installObservability } from './observability/index.ts';
import { maintenanceWriteGuard } from './backup/guard.ts';
import { getPrisma } from './plugins/prisma.ts';
import { createPluginHost } from './plugin-host.ts';
import { adminAuditRoutes } from './routes/admin/audit.ts';
import { adminBackupRoutes } from './routes/admin-backup.ts';
import { adminDeveloperRoutes } from './routes/admin/developer.ts';
import { adminJobsRoutes } from './routes/admin/jobs.ts';
import { adminMarketRoutes } from './routes/admin/market.ts';
import { adminPluginRoutes } from './routes/admin/plugins.ts';
import { adminSecretsRoutes } from './routes/admin/secrets.ts';
import { adminSettingsRoutes } from './routes/admin/settings.ts';
import { adminCurrencyRoutes } from './routes/admin/currency-rates.ts';
import { adminPaymentsRoutes } from './routes/admin/payments.ts';
import { adminSalesRoutes } from './routes/admin/sales.ts';
import { adminPermissionGroupRoutes } from './routes/admin/permission-groups.ts';
import { adminPermissionsRoutes } from './routes/admin/permissions.ts';
import { adminSigningRoutes } from './routes/admin/signing.ts';
import { adminUiRoutes } from './routes/admin/ui.ts';
import { adminUserRoutes } from './routes/admin/users.ts';
import { authRoutes } from './routes/auth.ts';
import { authOAuthRoutes } from './routes/auth-oauth.ts';
import { apiTokenRoutes } from './routes/api-tokens.ts';
import { healthRoutes } from './routes/health.ts';
import { registerMediaRoutes } from './media/index.ts';
import { mcpRoutes } from './mcp/index.ts';
import { navRoutes } from './routes/nav.ts';
import { notificationRoutes } from './routes/notifications.ts';
import { notificationStreamRoutes } from './routes/notifications-stream.ts';
import { platformRoutes } from './routes/platform.ts';
import { seoRoutes } from './routes/seo.ts';
import { openApiV1Routes } from './routes/open-api-v1.ts';
import { spV1Routes } from './routes/sp-v1.ts';
import { pluginRoutes } from './routes/plugin.ts';
import { initThemes, themeRoutes } from './routes/theme.ts';

export interface BuildAppOptions {
  /**
   * Shared Redis client for cross-replica rate limiting (ADR-0017 §2). When
   * absent (development / hermetic tests) the in-process store is used.
   */
  redis?: RedisClient | null;
}

/**
 * Translate `API_TRUST_PROXY` into Fastify's `trustProxy` option. Empty or
 * `false` trusts nothing; `true` trusts the immediate peer; anything else is a
 * comma-separated list of trusted proxy addresses/CIDRs.
 */
function trustProxyOption(): boolean | string[] {
  const raw = env.API_TRUST_PROXY?.trim();
  if (!raw || raw === 'false') return false;
  if (raw === 'true') return true;
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Build a configured Fastify instance. Register all plugins/routes here. */
export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  if (process.env.NODE_ENV === 'production' && !options.redis) {
    throw new InfraConfigError('生产环境必须配置 Redis：多副本的限流、会话与状态依赖共享存储。');
  }
  const app = Fastify({
    // HEAD routes are registered explicitly by the plugin dispatcher.
    exposeHeadRoutes: false,
    // Resolve `req.ip` through the reverse proxy only when explicitly trusted;
    // an untrusted X-Forwarded-For would otherwise let callers spoof their IP
    // and evade per-IP rate limits (audit M-4).
    trustProxy: trustProxyOption(),
    logger: {
      level: env.API_LOG_LEVEL,
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie'],
        censor: '[REDACTED]',
      },
    },
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    // HSTS (SECURITY-AUDIT-2026-10-04 M-2). Safe to send unconditionally:
    // browsers ignore it on plaintext responses, so it only takes effect once
    // the site is reached over HTTPS. No `preload` (irreversible opt-in).
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    // CSP. The API serves machine surfaces (JSON, assets, streams) that never
    // run scripts, so `script-src 'self'` is enough there — `'unsafe-inline'`
    // was only needed by the Swagger UI, which is now an admin-gated island
    // (SECURITY-AUDIT-2026-10-04 M-3 / L-2) and keeps its own relaxed policy.
    const isDocs =
      request.url === '/docs' ||
      request.url.startsWith('/docs/') ||
      request.url.startsWith('/docs?');
    reply.header(
      'Content-Security-Policy',
      isDocs
        ? "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; form-action 'self'; img-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'"
        : "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; form-action 'self'; img-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
    );
    // RFC 7807: normalise every error response to `application/problem+json` in
    // one place (ADR-0012). Success bodies pass through untouched. Legacy
    // `{ error }` bodies are promoted to `detail`; the compat `error` member is
    // no longer emitted (compatibility window closed).
    if (reply.statusCode >= 400 && typeof payload === 'string' && payload.length > 0) {
      const contentType = String(reply.getHeader('content-type') ?? '');
      if (contentType.includes('application/json')) {
        try {
          const body = JSON.parse(payload) as unknown;
          const problem = normalizeErrorBody(reply.statusCode, body, {
            instance: request.url,
            requestId: request.id,
          });
          reply.header('content-type', 'application/problem+json; charset=utf-8');
          reply.header('x-request-id', request.id);
          return JSON.stringify(problem);
        } catch {
          // Non-JSON payload (e.g. a streamed error): leave as-is.
        }
      }
    }
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    // PluginError is the SDK's deterministic contract (ADR-0012 §5): the plugin
    // chooses the code/status; the kernel renders it. Expected, not an internal
    // fault, so it is logged at info level. Everything else is a real fault.
    //
    // Brand check, not `instanceof`: plugin bundles are imported through a
    // cache-busted URL, so their `PluginError` can be a distinct class object
    // from the kernel's import. `instanceof` silently failed there and demoted
    // deterministic 4xx to 500.
    if (isPluginError(error)) {
      request.log.info({ code: error.code }, 'plugin error');
      return reply.code(error.status).send(
        buildProblem({
          status: error.status,
          code: error.code,
          ...(error.detail ? { detail: error.detail } : {}),
          instance: request.url,
          requestId: request.id,
          ...(error.errors ? { errors: error.errors } : {}),
        }),
      );
    }
    app.log.error(error);
    const clientError = error as {
      statusCode?: unknown;
      message?: unknown;
      validation?: unknown;
    };
    if (Array.isArray(clientError.validation)) {
      return reply.code(422).send(
        buildProblem({
          status: 422,
          code: 'validation.invalid',
          detail: '请求参数无效',
          instance: request.url,
          requestId: request.id,
        }),
      );
    }
    if (
      typeof clientError.statusCode === 'number' &&
      clientError.statusCode >= 400 &&
      clientError.statusCode < 500
    ) {
      return reply.code(clientError.statusCode).send(
        buildProblem({
          status: clientError.statusCode,
          detail: typeof clientError.message === 'string' ? clientError.message : '无效请求',
          instance: request.url,
          requestId: request.id,
        }),
      );
    }
    return reply.code(500).send(
      buildProblem({
        status: 500,
        code: 'internal.unexpected',
        detail: '服务器内部错误',
        instance: request.url,
        requestId: request.id,
      }),
    );
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send(
      buildProblem({
        status: 404,
        code: 'request.not_found',
        detail: '接口不存在',
        instance: request.url,
        requestId: request.id,
      }),
    );
  });

  // The web BFF talks to this API server-to-server. Do not reflect arbitrary
  // browser origins with credentials; opt in only for explicitly configured clients.
  void app.register(cors, {
    origin: env.API_CORS_ORIGINS.length > 0 ? env.API_CORS_ORIGINS : false,
    credentials: env.API_CORS_ORIGINS.length > 0,
  });
  void app.register(cookie);
  void app.register(rateLimit, {
    global: false,
    // Multi-replica: share counters through Redis so the limit holds across
    // nodes. Production always has Redis (enforced by readInfraConfig); the
    // in-process store is a development/test fallback.
    ...(options.redis ? { redis: options.redis, nameSpace: REDIS_KEY_PREFIX.rateLimit } : {}),
  });
  void app.register(multipart, {
    limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 4 },
  });

  void app.register(swagger, {
    openapi: {
      info: { title: 'StackPanel API', version: KERNEL_VERSION },
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
    },
  });

  const dispatcher = new PluginDispatcher();
  app.decorate('pluginDispatcher', dispatcher);
  const extensions = new ExtensionService(getPrisma());
  // Swagger UI exposes every route, permission and internal schema — an ideal
  // recon target (SECURITY-AUDIT-2026-10-04 M-3). Mount it in an encapsulated
  // scope whose `onRequest` guard requires `platform.admin`; unauthorized
  // callers get a plain 404 so the endpoint's existence is not disclosed.
  void app.register(async (docsScope) => {
    docsScope.addHook('onRequest', async (request, reply) => {
      const user = await extractSession(request, reply);
      if (!user?.permissions.has('platform.admin')) {
        return reply.code(404).send(
          buildProblem({
            status: 404,
            code: 'request.not_found',
            instance: request.url,
            requestId: request.id,
          }),
        );
      }
    });
    await docsScope.register(swaggerUi, {
      routePrefix: '/docs',
      transformSpecification: (spec: { paths?: Record<string, unknown> }) => {
        const paths = (spec.paths ??= {});
        // Open platform v1 (PLAN-open-platform P1): the public surface is derived
        // from the capability registry so docs and discovery never drift. Plugin
        // capabilities contribute once their plugin registers; they are merged
        // from the dispatcher's alias entries to avoid walking runtime internals.
        for (const capability of [
          ...CAPABILITIES,
          ...dispatcher.listOpenApiRoutes().map((route) => ({
            method: route.method,
            path: route.path,
            summary: `Plugin capability (${route.openApi?.capabilityId ?? route.pluginId})`,
            scope: route.openApi?.scope ?? route.permission ?? null,
            mutating: route.openApi?.mutating ?? route.method !== 'GET',
          })),
        ]) {
          const pathItem = (paths[capability.path] ?? {}) as Record<string, unknown>;
          pathItem[capability.method.toLowerCase()] = toOpenApiOperation({
            method: capability.method,
            path: capability.path,
            summary: capability.summary,
            scope: capability.scope,
            mutating: capability.mutating,
          });
          paths[capability.path] = pathItem;
        }
        for (const entry of dispatcher.list()) {
          if (entry.kind === 'raw') continue;
          // Open-platform aliases are already documented from the capability
          // registry (tag `open-api`); don't overwrite them as plugin routes.
          if (entry.openApi) continue;
          const openApiPath = toOpenApiPath(entry.path);
          const pathItem = (paths[openApiPath] ?? {}) as Record<string, unknown>;
          pathItem[entry.method.toLowerCase()] = {
            tags: ['plugins'],
            summary: `Plugin route (auth: ${entry.auth ?? 'public'})`,
            ...(entry.auth !== 'public' ? { security: [{ bearerAuth: [] }] } : {}),
            responses: {
              200: { description: 'OK' },
              401: { description: 'Unauthorized' },
              404: { description: 'Not found (plugin inactive)' },
            },
          };
          paths[openApiPath] = pathItem;
        }
        return spec;
      },
    });
  });

  // Shared kernel services + plugin runtime. Assembled by the same factory the
  // worker process uses, so plugin `ctx` is identical in both processes.
  const host = createPluginHost({
    logger: {
      info: (message: string) => app.log.info(message),
      warn: (message: string) => app.log.warn(message),
      error: (message: string) => app.log.error(message),
    },
    extensions,
    registerRoute: (pluginId: string, route: PluginRoute, isActive: () => boolean, openApi) =>
      dispatcher.register({
        pluginId,
        method: route.method,
        path: route.path,
        kind: route.kind ?? 'handler',
        ...(route.auth ? { auth: route.auth } : {}),
        ...(route.permission ? { permission: route.permission } : {}),
        ...(route.cors ? { cors: route.cors } : {}),
        ...(route.timeout !== undefined ? { timeout: route.timeout } : {}),
        ...(route.bodyLimit !== undefined ? { bodyLimit: route.bodyLimit } : {}),
        ...(openApi ? { openApi } : {}),
        handler: route.handler,
        isActive,
      }),
    removeRoutes: (pluginId: string) => dispatcher.removeByPlugin(pluginId),
  });
  const runtime = host.runtime;
  app.decorate('pluginHost', host);
  app.decorate('payments', host.payments);
  app.decorate('wallet', host.wallet);
  app.decorate('fx', host.fx);
  app.decorate('auth', host.auth);
  app.decorate('notifications', host.notifications);
  app.decorate('state', host.state);
  // Kernel sweeps run as BullMQ recurring jobs (S6) so they execute once across
  // the cluster instead of once per replica. Registration is synchronous into
  // the canonical registry; jobs start when initInfra() attaches the backend.
  host.registerKernelJobs();
  app.decorate('pluginRuntime', runtime);
  installExtensionRoutes(app, extensions);

  // ADR-0018 导出 / 导入（BACKUP 流）：导入期间对写请求统一返回 503（白名单见 guard.ts），
  // 自助端点 /admin/backup/* 自带校验与二次确认。
  app.addHook('preHandler', maintenanceWriteGuard);

  void app.register(healthRoutes);
  void app.register(registerMediaRoutes);
  void app.register(authRoutes);
  void app.register(authOAuthRoutes);
  void app.register(navRoutes);
  void app.register(notificationRoutes);
  // Live notification stream (SSE): same inbox, pushed instead of polled. Kept
  // a separate module so the frozen REST handlers above stay untouched.
  void app.register(notificationStreamRoutes);
  // SEO 输送（ADR-0011）：聚合各插件的 `seo.provider`，公开只读。插件负责内容、
  // 平台负责输送；站点源（apps/web）拉取这些端点输出 sitemap/robots/feed。
  void app.register(seoRoutes);
  void app.register(apiTokenRoutes);
  void app.register(platformRoutes);
  void app.register(openApiV1Routes);
  // SP-V1（P3）：渠道伙伴签名入口。独立作用域（preParsing 仅作用于 /sp/v1/*）。
  void app.register(spV1Routes);
  // MCP (PLAN-open-platform P2): a transport adapter over the same capability
  // registry and /api/v1 handlers. Registered last among kernel HTTP routes so
  // its `/mcp` paths never collide with plugin dispatcher catch-alls below.
  void app.register(mcpRoutes);
  // Usage audit for the open platform: one row per token-authenticated call,
  // kernel-owned routes and plugin aliases alike. Best-effort; never affects the
  // response.
  app.addHook('onResponse', async (request, reply) => {
    recordTokenUsage(request, reply, runtime.listCapabilities());
  });
  void app.register(pluginRoutes);
  void app.register(themeRoutes);
  app.addHook('onReady', async () => {
    await initThemes();
    await seedDefaultBrand();
  });
  void app.register(adminUserRoutes);
  void app.register(adminAuditRoutes);
  void app.register(adminJobsRoutes);
  void app.register(adminMarketRoutes);
  void app.register(adminSettingsRoutes);
  void app.register(adminSecretsRoutes);
  void app.register(adminSigningRoutes);
  void app.register(adminPluginRoutes);
  void app.register(adminUiRoutes);
  void app.register(adminCurrencyRoutes);
  void app.register(adminPaymentsRoutes);
  void app.register(adminSalesRoutes);
  void app.register(adminPermissionGroupRoutes);
  void app.register(adminPermissionsRoutes);
  void app.register(adminBackupRoutes);
  void app.register(adminDeveloperRoutes);

  // 契约治理（CONTRACT-SEC / G1）：API 版本与弃用响应头（RFC 8594）。登记表为空时为空操作。
  registerApiVersioning(app);

  // ADR-0015 可观测与运维（OBS 流）：HTTP 指标埋点 + `/metrics` 路由 + 审计保留周期任务。
  // 自包含、默认关闭（未配置环境变量时为空操作）；OTel 追踪在 buildApp 之前由入口启动。
  installObservability(app);

  // Seed built-in plugins and register everything discovered in data/plugins
  // before the server starts accepting requests (routes live on the dispatcher).
  app.addHook('onReady', async () => {
    await host.registerPlugins();
  });

  // Catch-all for plugin routes: registered last so kernel routes win.
  // Body routing must be installed before requests are served, so raw plugin
  // routes receive an unparsed body stream.
  installBodyRouting(app, dispatcher);
  dispatcher.install(app);

  return app;
}
