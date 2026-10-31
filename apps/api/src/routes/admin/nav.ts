import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  NAV_LABEL_MAX,
  NAV_SURFACES,
  applyNavEntriesIncludingHidden,
  deleteNavEntry,
  listNavEntries,
  normalizeNavHref,
  normalizeNavLabel,
  resolveBaseNav,
  upsertNavEntry,
  type NavSurface,
} from '../../lib/nav-entries.ts';
import { auditContext, writeAudit } from '../../plugins/audit.ts';
import { requireAuth, requireRole } from '../../plugins/auth.ts';

const adminOnly = [requireAuth, requireRole('ADMIN')];

const surfaceSchema = z.enum(NAV_SURFACES);

const layoutSchema = z
  .object({
    items: z
      .array(
        z.object({
          href: z.string().min(1).max(512),
          label: z.string().max(NAV_LABEL_MAX).nullable().optional(),
          hidden: z.boolean().optional(),
        }),
      )
      .max(200),
  })
  .strict();

const customSchema = z
  .object({
    label: z.string().min(1).max(NAV_LABEL_MAX),
    href: z.string().min(1).max(512),
  })
  .strict();

/**
 * 后台菜单编辑（对标 #12.3）。
 *
 * 注意这里能做和不能做的事：能改顺序、文案、可见性，能加自己的链接；**不能**
 * 通过菜单授予权限 —— 隐藏菜单项不影响路由守卫，自定义链接也不携带任何角色。
 */
export async function adminNavRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/nav', { preHandler: adminOnly }, async (request) => {
    const query = z.object({ surface: surfaceSchema }).safeParse(request.query ?? {});
    const surface: NavSurface = query.success ? query.data.surface : 'admin';
    const [base, entries] = await Promise.all([resolveBaseNav(app, surface), listNavEntries(surface)]);
    return {
      surface,
      items: applyNavEntriesIncludingHidden(base, entries, surface),
    };
  });

  // 保存当前排布：给出的顺序就是最终顺序，label 留空表示沿用默认文案。
  app.put('/admin/nav/:surface', { preHandler: adminOnly }, async (request, reply) => {
    const params = z.object({ surface: surfaceSchema }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: '非法的菜单区域' });
    const body = layoutSchema.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: '参数无效' });

    const surface = params.data.surface;
    const items = body.data.items;
    const seen = new Set<string>();
    for (const item of items) {
      const href = normalizeNavHref(item.href);
      if (!href) return reply.code(400).send({ error: `链接无效：${item.href}` });
      // 同一区域里同一链接只能出现一次：菜单里出现两个同名入口只会让人点错。
      if (seen.has(href)) return reply.code(400).send({ error: `链接重复：${href}` });
      seen.add(href);
    }

    const base = await resolveBaseNav(app, surface);
    const known = new Set(base.map((item) => item.href));
    const existing = await listNavEntries(surface);
    const overrides = new Map(existing.map((entry) => [entry.href, entry]));
    const editor = request.user?.id ?? null;

    for (const [index, item] of items.entries()) {
      const href = normalizeNavHref(item.href) as string;
      const previous = overrides.get(href);
      const custom = previous?.custom ?? !known.has(href);
      if (custom && !previous) {
        // 不在默认菜单里、也没有现存行的 href 不是「自定义项」，拒绝凭空创造。
        return reply.code(400).send({ error: `未知菜单项：${href}（自定义链接请用新增接口）` });
      }
      await upsertNavEntry({
        surface,
        href,
        label: normalizeNavLabel(item.label ?? previous?.label ?? null),
        sortOrder: index,
        hidden: item.hidden ?? previous?.hidden ?? false,
        custom,
        updatedBy: editor,
      });
    }

    await writeAudit({
      ...auditContext(request),
      action: 'nav.layout.save',
      resource: 'nav.layout',
      meta: { surface, count: items.length },
    });

    const [nextBase, nextEntries] = await Promise.all([
      resolveBaseNav(app, surface),
      listNavEntries(surface),
    ]);
    return { surface, items: applyNavEntriesIncludingHidden(nextBase, nextEntries, surface) };
  });

  app.post('/admin/nav/:surface/items', { preHandler: adminOnly }, async (request, reply) => {
    const params = z.object({ surface: surfaceSchema }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: '非法的菜单区域' });
    const body = customSchema.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: '参数无效' });

    const surface = params.data.surface;
    const href = normalizeNavHref(body.data.href);
    if (!href) return reply.code(400).send({ error: '链接无效：需以 / 开头或为 http(s) 地址' });
    const label = normalizeNavLabel(body.data.label);
    if (!label) return reply.code(400).send({ error: '请填写菜单名称' });

    const [base, entries] = await Promise.all([resolveBaseNav(app, surface), listNavEntries(surface)]);
    if ([...base.map((item) => item.href), ...entries.map((entry) => entry.href)].includes(href)) {
      return reply.code(409).send({ error: '该链接已在菜单中' });
    }
    const maxOrder = entries.reduce(
      (max, entry) => (entry.sortOrder !== null && entry.sortOrder > max ? entry.sortOrder : max),
      base.length - 1,
    );

    const row = await upsertNavEntry({
      surface,
      href,
      label,
      sortOrder: maxOrder + 1,
      custom: true,
      updatedBy: request.user?.id ?? null,
    });
    await writeAudit({
      ...auditContext(request),
      action: 'nav.entry.create',
      resource: 'nav.entry',
      meta: { surface, href, label },
    });

    const [nextBase, nextEntries] = await Promise.all([
      resolveBaseNav(app, surface),
      listNavEntries(surface),
    ]);
    return { entry: row, items: applyNavEntriesIncludingHidden(nextBase, nextEntries, surface) };
  });

  // 删除一条覆写：自定义项消失，默认项回到原样（不是「删除菜单」）。
  app.delete('/admin/nav/items/:id', { preHandler: adminOnly }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: '参数无效' });
    const removed = await deleteNavEntry(params.data.id);
    if (!removed) return reply.code(404).send({ error: '菜单项不存在' });
    await writeAudit({
      ...auditContext(request),
      action: 'nav.entry.delete',
      resource: 'nav.entry',
      meta: { id: params.data.id },
    });
    return { ok: true };
  });
}
