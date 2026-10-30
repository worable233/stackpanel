import { getPrisma } from '../plugins/prisma.ts';
import type { FastifyInstance } from 'fastify';
import { EXTENSION_POINTS } from '@stackpanel/sdk';
import type { NavItem } from '@stackpanel/sdk';
import { z } from 'zod';
import { requireAuth } from '../plugins/auth.ts';

const surfaceSchema = z.enum(['public', 'account', 'admin']);

/** Kernel-provided navigation defaults for a surface. */
const KERNEL_NAV: Record<'public' | 'account' | 'admin', NavItem[]> = {
  public: [],
  account: [
    { surface: 'account', label: '账户概览', href: '/account' },
    { surface: 'account', label: '账户设置', href: '/account/settings' },
    { surface: 'account', label: '我的通知', href: '/account/notifications' },
  ],
  admin: [
    { surface: 'admin', label: '工作台', href: '/admin' },
    { surface: 'admin', label: '用户管理', href: '/admin/users' },
    { surface: 'admin', label: '系统设置', href: '/admin/settings' },
    { surface: 'admin', label: '插件管理', href: '/admin/plugins' },
    { surface: 'admin', label: '权限模板', href: '/admin/rbac' },
    // 支付记录是手动收款（银行转账/收款码）的唯一结算入口：没有它，运营者无法把
    // 一笔已到账的转账变成已付订单，订单永远停在 PENDING。
    { surface: 'admin', label: '支付记录', href: '/admin/payments' },
    { surface: 'admin', label: '审计日志', href: '/admin/audit' },
    { surface: 'admin', label: '主题管理', href: '/admin/themes' },
    { surface: 'admin', label: '通知中心', href: '/admin/notifications' },
    // 更新中心必须在 API 导航里：管理端布局在 API 可达时用本列表**整体替换**
    // 前端 fallback，缺了这一项，侧边栏就永远进不去 `/admin/updates`。
    { surface: 'admin', label: '升级', href: '/admin/updates' },
  ],
};

/**
 * Aggregated navigation for platform-owned surfaces. Public navigation belongs
 * to the active theme, while account and admin require an authenticated user.
 */
export async function navRoutes(app: FastifyInstance): Promise<void> {
  app.get('/nav/:surface', async (request, reply) => {
    const params = z.object({ surface: surfaceSchema }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: '非法的导航区域' });
    const { surface } = params.data;
    if (surface !== 'public') {
      await requireAuth(request, reply);
      if (reply.sent) return reply;
    }
    if (surface === 'admin' && !request.user?.permissions.has('platform.admin')) {
      return reply.code(403).send({ error: '没有权限执行此操作' });
    }
    const pluginItems = app.pluginRuntime.getExtensions<NavItem>(EXTENSION_POINTS.webNav);
    const items = [...KERNEL_NAV[surface], ...pluginItems.filter((i) => i.surface === surface)];
    if (surface === 'account') {
      const setting = await getPrisma().setting.findUnique({where:{key:'agent.enabled'}});
      const value = setting?.value;
      if (value === true || (value && typeof value === 'object' && !Array.isArray(value) && value.enabled === true)) items.push({surface:'account',label:'Agent',href:'/account/agent'});
    }
    return { items };
  });
}
