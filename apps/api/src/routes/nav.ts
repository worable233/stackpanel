import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NAV_SURFACES, applyNavEntries, listNavEntries, resolveBaseNav } from '../lib/nav-entries.ts';
import { requireAuth } from '../plugins/auth.ts';

const surfaceSchema = z.enum(NAV_SURFACES);

/**
 * 平台自有区域（账户 / 后台）的导航。
 *
 * 组成顺序：内核默认项 → 插件声明项 → 运营覆写（排序 / 改名 / 隐藏）→ 自定义链接。
 * 公开导航归主题管，这里不参与。
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
    const [base, entries] = await Promise.all([
      resolveBaseNav(app, surface),
      listNavEntries(surface),
    ]);
    // 对外契约保持 { surface, label, href } 三字段：编辑用的元信息不外泄。
    const items = applyNavEntries(base, entries, surface).map((item) => ({
      surface: item.surface,
      label: item.label,
      href: item.href,
    }));
    return { items };
  });
}
