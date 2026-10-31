/**
 * 市场插件后端（PLAN-github-distribution-and-updates §9、ADR-0020 D3）。
 *
 * 市场曾是内核的一部分（`/admin/market/*` + `lib/market.ts` + 后台页面）。按
 * 「市场做成插件、不留在内核」的目标，业务面迁到这里，内核只保留分发安全原语并以
 * `kernel.market` 暴露（验签目录、统一安装事务、运行时激活）。
 *
 * 插件自带：
 * - `GET /market/admin/plugins`、`GET /market/admin/themes`：浏览（本地 + 远程目录）
 * - `POST /market/admin/plugins/:id/install`、`/market/admin/themes/:id/install`：安装
 * - `POST /market/admin/refresh`：手动刷新目录快照（与 `/admin/distribution/refresh` 共享冷却）
 * - 后台页面 `/admin/plugin/market`（前端包，见 `frontend/`）
 *
 * 权限：所有路由要求 `market.admin`（`roleTemplates` 默认授予 ADMIN 组）。
 * 审计：安装写 `market.plugin.install` / `market.theme.install`，目录刷新写
 * `market.catalog.refresh`，与迁移前动作名一致。
 */

import { z } from 'zod';
import type { HttpReply, HttpRequest, PluginContext } from '@stackpanel/sdk';
import { definePlugin, isPluginError, PluginError } from '@stackpanel/sdk';
import type { MarketService } from '@stackpanel/sdk';

/** 路由前缀；避免与其他插件或内核路径冲突。 */
const BASE = '/market/admin';

const kindSchema = z.enum(['plugin', 'theme']);
const idSchema = z.object({ id: z.string().min(1).max(64) });

let ctx: PluginContext | null = null;

/** 解析内核市场能力服务（未激活时给出 503 而非崩溃）。 */
function market(): MarketService {
  if (!ctx) throw new PluginError('market.unavailable', 503, '市场插件未就绪');
  const service = ctx.getService<MarketService>('kernel.market');
  if (!service) {
    throw new PluginError('market.serviceMissing', 503, '内核未提供市场能力服务');
  }
  return service;
}

function requireContext(): PluginContext {
  if (!ctx) throw new PluginError('market.unavailable', 503, '市场插件未就绪');
  return ctx;
}

/** 供 finder 与路由共享的「列出某类条目」实现。 */
async function listPackages(kind: 'plugin' | 'theme') {
  return (await market().list(kind)).sort((a, b) => a.id.localeCompare(b.id));
}

/** 市场安装的生命周期通知（与内核上传路径同构：成功/失败都给操作者一条）。 */
async function notifyLifecycle(
  req: HttpRequest,
  kind: 'plugin' | 'theme',
  targetId: string,
  outcome: { ok: true; version: string; upgraded?: boolean } | { ok: false; error: string },
): Promise<void> {
  const userId = req.user?.id;
  if (!userId) return;
  const noun = kind === 'plugin' ? '插件' : '主题';
  const label = `「${targetId}」`;
  try {
    await requireContext().notifications.create({
      userId,
      type: `system.${kind}.${outcome.ok ? (outcome.upgraded ? 'update' : 'install') : 'install'}`,
      title: outcome.ok
        ? `${noun}${label}${outcome.upgraded ? '升级完成' : '安装完成'}`
        : `${noun}${label}安装失败`,
      body: outcome.ok
        ? `${label}${outcome.upgraded ? '已升级' : '已安装'} v${outcome.version}`
        : outcome.error,
      link: kind === 'plugin' ? '/admin/plugins' : '/admin/themes',
      data: { kind: 'lifecycle', target: kind, action: 'install', id: targetId, ok: outcome.ok },
      status: outcome.ok ? 'success' : 'error',
    });
  } catch (error) {
    // 通知是附带的：失败只告警，不影响安装结果。
    requireContext().logger.warn(
      `market: lifecycle notification failed for ${kind} ${targetId}: ${String(error)}`,
    );
  }
}

/** 安装并写审计；失败转成可读的错误码（不吞掉原因）。 */
async function install(req: HttpRequest, kind: 'plugin' | 'theme', id: string) {
  const context = requireContext();
  try {
    const result = await market().install(kind, id);
    await context.auth.audit({
      action: kind === 'plugin' ? 'market.plugin.install' : 'market.theme.install',
      resource: kind,
      resourceId: id,
      ...(req.user ? { actorId: req.user.id } : {}),
      meta: {
        version: result.version,
        source: result.source,
        ...(result.publisher ? { publisher: result.publisher } : {}),
        ...(result.keyId ? { keyId: result.keyId } : {}),
      },
    });
    await notifyLifecycle(req, kind, id, {
      ok: true,
      version: result.version,
      upgraded: result.upgraded,
    });
    return result;
  } catch (error) {
    // `PluginError.message` 是**错误码**（签名 `PluginError(code, status, detail)`），
    // 通知正文要用 detail，否则用户在通知中心看到的是 `market.sourceUnavailable`。
    //
    // 判定用 `isPluginError` 而不是 `instanceof`：内核与插件可能持有**两个** SDK
    // 模块实例（插件 bundle 走 cache-busted URL 加载），`instanceof` 会漏判，把
    // 「目录限流 / 验签失败」这类精确错误码降级成通用的 `market.installFailed`。
    const message = isPluginError(error)
      ? (error.detail ?? error.code)
      : error instanceof Error
        ? error.message
        : String(error);
    // PluginError 是预期内的拒绝（未配置源、验签失败等），同样要给操作者回执。
    await notifyLifecycle(req, kind, id, { ok: false, error: message });
    if (isPluginError(error)) throw error;
    throw new PluginError('market.installFailed', 409, message);
  }
}

export const marketPlugin = definePlugin({
  manifest: {
    id: 'market',
    name: '应用市场',
    version: '0.1.0',
    description: '浏览本地与已签名远程目录，安装/升级插件与主题。',
    permissions: [
      {
        key: 'market.admin',
        name: '管理应用市场',
        description: '浏览市场并安装、升级插件与主题。',
      },
    ],
    roleTemplates: [{ role: 'ADMIN', permissions: ['market.admin'] }],
  },
  // `kernel.market` is provided by the kernel before any plugin registers, so a
  // missing service fails activation with a clear error instead of at first use.
  inject: ['kernel.market'],
  onRegister(pluginCtx) {
    ctx = pluginCtx;
  },
  onActivate(pluginCtx) {
    ctx = pluginCtx;
  },
  onDeactivate() {
    ctx = null;
  },
  routes: [
    {
      method: 'GET',
      path: `${BASE}/plugins`,
      auth: 'admin',
      permission: 'market.admin',
      handler: async (): Promise<unknown> => ({ plugins: await listPackages('plugin') }),
    },
    {
      method: 'GET',
      path: `${BASE}/themes`,
      auth: 'admin',
      permission: 'market.admin',
      handler: async (): Promise<unknown> => ({ themes: await listPackages('theme') }),
    },
    {
      // 手动刷新目录快照：进程重启后内存里没有快照，市场页只能显示「等待首次刷新」。
      // 冷启动时目录状态是只读的（渲染路径不出网），所以必须有一个显式入口。
      method: 'POST',
      path: `${BASE}/refresh`,
      auth: 'admin',
      permission: 'market.admin',
      handler: async (req: HttpRequest): Promise<unknown> => {
        const service = market();
        if (!service.refreshCatalog) {
          throw new PluginError('market.refreshUnavailable', 503, '内核未提供目录刷新能力');
        }
        const result = await service.refreshCatalog();
        await requireContext().auth.audit({
          action: 'market.catalog.refresh',
          resource: 'catalog',
          ...(req.user ? { actorId: req.user.id } : {}),
          meta: {
            configured: result.configured,
            throttled: result.throttled ?? false,
            ...(result.sequence !== null && result.sequence !== undefined
              ? { sequence: result.sequence }
              : {}),
            ...(result.failure ? { failure: result.failure.kind } : {}),
          },
        });
        // 「没配目录」「刚查过」「查失败」都不是成功：按钮不能报成成功，否则运维会
        // 以为目录是好的。三种情况都给稳定错误码，界面才能分别说清楚。
        if (!result.configured) {
          throw new PluginError('market.catalogOffline', 409, '未配置远程目录');
        }
        if (result.throttled) {
          const retryAfterSeconds = Math.max(1, Math.ceil((result.retryAtMs ?? 0) / 1000));
          throw new PluginError(
            'market.refreshThrottled',
            429,
            `刚检查过目录，${retryAfterSeconds} 秒后可再试`,
            undefined,
            { retryAfterSeconds },
          );
        }
        if (result.failure) {
          throw new PluginError('market.sourceUnavailable', 502, result.failure.message);
        }
        return { refreshed: true, sequence: result.sequence ?? null };
      },
    },
    {
      method: 'POST',
      path: `${BASE}/plugins/:id/install`,
      auth: 'admin',
      permission: 'market.admin',
      handler: async (req: HttpRequest, reply: HttpReply): Promise<unknown> => {
        const params = idSchema.safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: '插件 ID 无效' });
        const result = await install(req, 'plugin', params.data.id);
        // 本地来源沿用历史 201；远程目录升级返回 200（与迁移前一致）。
        const status = result.source === 'local' || !result.upgraded ? 201 : 200;
        return reply.code(status).send({ installed: true, ...result });
      },
    },
    {
      method: 'POST',
      path: `${BASE}/themes/:id/install`,
      auth: 'admin',
      permission: 'market.admin',
      handler: async (req: HttpRequest, reply: HttpReply): Promise<unknown> => {
        const params = idSchema.safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: '主题 ID 无效' });
        const result = await install(req, 'theme', params.data.id);
        const status = result.source === 'local' || !result.upgraded ? 201 : 200;
        return reply.code(status).send({ installed: true, ...result });
      },
    },
    {
      method: 'GET',
      path: `${BASE}/kinds`,
      auth: 'admin',
      permission: 'market.admin',
      handler: async (): Promise<unknown> => ({ kinds: kindSchema.options }),
    },
    {
      /**
       * 来源健康度：本地来源是否可用、远程目录是否配置/可用、最近失败原因。
       * 默认远程源开启后，目录不可用会让市场看起来「空」，运维需要这个入口定位。
       */
      method: 'GET',
      path: `${BASE}/status`,
      auth: 'admin',
      permission: 'market.admin',
      handler: async (): Promise<unknown> => {
        const service = market();
        if (typeof service.status !== 'function') {
          return { status: null };
        }
        return { status: await service.status() };
      },
    },
  ],
});

export default marketPlugin;
