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
    { surface: 'account', label: 'API 密钥', href: '/account/api-keys' },
    { surface: 'account', label: '账户安全', href: '/account/security' },
    { surface: 'account', label: '我的通知', href: '/account/notifications' },
  ],
  admin: [
    { surface: 'admin', label: '工作台', href: '/admin' },
    { surface: 'admin', label: '用户管理', href: '/admin/users' },
    { surface: 'admin', label: '系统设置', href: '/admin/settings' },
    { surface: 'admin', label: '插件管理', href: '/admin/plugins' },
    { surface: 'admin', label: '权限模板', href: '/admin/rbac' },
    { surface: 'admin', label: '审计日志', href: '/admin/audit' },
    { surface: 'admin', label: '开发者控制台', href: '/admin/developer' },
    { surface: 'admin', label: '主题管理', href: '/admin/themes' },
    { surface: 'admin', label: '通知中心', href: '/admin/notifications' },
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
    return { items };
  });
}
