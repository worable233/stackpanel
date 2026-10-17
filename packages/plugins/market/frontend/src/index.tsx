/**
 * 市场插件前端（PLAN-github-distribution-and-updates §9）。
 *
 * 后台页面渲染在内核后台插件路由之下（`/admin/plugin/market`）：
 * - 数据经声明的 finder 从插件自身路由读取（`/market/admin/plugins|themes`）；
 * - 安装经声明的 plugin action 执行，内核 BFF 负责会话、权限、审计入口与
 *   action-target 校验（声明必须与插件已注册路由逐字一致）。
 *
 * 这里不复制任何验签或安装逻辑——那是内核 `kernel.market` 服务的职责。
 */
import { z } from 'zod';
import type { FrontendPackage, FinderProvider, PluginActionDefinition } from '@stackpanel/sdk';
import { messages } from './i18n.js';

const marketPackageSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string().optional(),
  author: z.string().optional(),
  kind: z.enum(['plugin', 'theme']),
  installed: z.boolean(),
  installedVersion: z.string().nullable().optional(),
  upgradable: z.boolean(),
  current: z.boolean(),
  builtin: z.boolean(),
  frontend: z
    .object({
      available: z.boolean(),
      pages: z.array(z.object({ path: z.string(), component: z.string() })),
      finders: z.array(z.string()),
    })
    .optional(),
});

const pluginsResponseSchema = z.object({ plugins: z.array(marketPackageSchema) });
const themesResponseSchema = z.object({ themes: z.array(marketPackageSchema) });

const marketFinders: Record<string, FinderProvider> = {
  'market.adminPlugins': {
    handler: async (_input, ctx) =>
      (await ctx.api.get('/market/admin/plugins', pluginsResponseSchema)).plugins,
  },
  'market.adminThemes': {
    handler: async (_input, ctx) =>
      (await ctx.api.get('/market/admin/themes', themesResponseSchema)).themes,
  },
};

/**
 * 安装动作。`path` 必须与插件路由逐字一致，`permission` 必须与路由权限一致，
 * 否则内核会拒绝（action-target 校验）。
 */
const marketActions: PluginActionDefinition[] = [
  {
    id: 'market.install-plugin',
    method: 'POST',
    path: '/market/admin/plugins/:id/install',
    permission: 'market.admin',
    input: [{ name: 'id', type: 'string', required: true, maxLength: 64 }],
  },
  {
    id: 'market.install-theme',
    method: 'POST',
    path: '/market/admin/themes/:id/install',
    permission: 'market.admin',
    input: [{ name: 'id', type: 'string', required: true, maxLength: 64 }],
  },
];

export const frontend: FrontendPackage = {
  locales: ['zh-CN', 'en-US'],
  messages,
  finders: marketFinders,
  ui: {
    actions: marketActions,
    adminRoutes: [
      {
        path: '/',
        component: 'admin/market',
        permission: 'market.admin',
        nav: { labelKey: 'nav.label', groupKey: 'nav.group' },
        data: [
          { finder: 'market.adminPlugins', as: 'plugins' },
          { finder: 'market.adminThemes', as: 'themes' },
        ],
      },
    ],
  },
};

export default frontend;
