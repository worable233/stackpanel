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
 * - 后台页面 `/admin/plugin/market`（前端包，见 `frontend/`）
 *
 * 权限：所有路由要求 `market.admin`（`roleTemplates` 默认授予 ADMIN 组）。
 * 审计：安装写 `market.plugin.install` / `market.theme.install`，与迁移前动作名一致。
 */

import { z } from 'zod';
import type { HttpReply, HttpRequest, PluginContext } from '@stackpanel/sdk';
import { definePlugin, PluginError } from '@stackpanel/sdk';
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
    return result;
  } catch (error) {
    if (error instanceof PluginError) throw error;
    throw new PluginError(
      'market.installFailed',
      409,
      error instanceof Error ? error.message : String(error),
    );
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
