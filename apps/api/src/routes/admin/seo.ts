import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  SEO_PAGE_LIMITS,
  deleteSeoPage,
  isValidSeoPageUrl,
  listSeoPages,
  normalizeSeoPagePath,
  upsertSeoPage,
  type SeoPageRow,
} from '../../lib/seo-pages.ts';
import { auditContext, writeAudit } from '../../plugins/audit.ts';
import { getPrisma } from '../../plugins/prisma.ts';
import { requireAuth, requireRole } from '../../plugins/auth.ts';

const adminOnly = [requireAuth, requireRole('ADMIN')];

const upsertSchema = z
  .object({
    path: z.string().min(1).max(SEO_PAGE_LIMITS.path),
    title: z.string().max(SEO_PAGE_LIMITS.title).nullable().optional(),
    description: z.string().max(SEO_PAGE_LIMITS.description).nullable().optional(),
    ogImage: z.string().max(SEO_PAGE_LIMITS.url).nullable().optional(),
    canonical: z.string().max(SEO_PAGE_LIMITS.url).nullable().optional(),
    noindex: z.boolean().optional(),
  })
  .strict();

function toView(row: SeoPageRow) {
  return {
    id: row.id,
    path: row.path,
    title: row.title,
    description: row.description,
    ogImage: row.ogImage,
    canonical: row.canonical,
    noindex: row.noindex,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * 逐页 SEO 后台编辑（对标 #12.4）。
 *
 * 只有「运营想改的字段」在这里；实体内容仍由插件 `seo.provider` 提供，
 * 覆写按字段合并在它之上（见 `lib/seo-pages.ts` 顶部注释）。
 */
export async function adminSeoRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/admin/seo/pages',
    { preHandler: adminOnly, schema: { security: [{ bearerAuth: [] }] } },
    async (request) => {
      const query = request.query as Record<string, unknown>;
      const result = await listSeoPages(getPrisma(), {
        query: typeof query['query'] === 'string' ? query['query'] : undefined,
        page: Number(query['page']) || 1,
        pageSize: Number(query['pageSize']) || 50,
      });
      return { ...result, pages: result.pages.map(toView) };
    },
  );

  app.put(
    '/admin/seo/pages',
    { preHandler: adminOnly, schema: { security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      const body = upsertSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: '参数无效' });
      const path = normalizeSeoPagePath(body.data.path);
      if (!path) {
        return reply.code(400).send({ error: '路径无效：需以 / 开头，且不能带查询串或锚点' });
      }
      for (const field of ['ogImage', 'canonical'] as const) {
        const value = body.data[field];
        if (value && !isValidSeoPageUrl(value)) {
          return reply
            .code(400)
            .send({ error: `${field} 必须是站内路径（以 / 开头）或 http(s) 绝对地址` });
        }
      }
      const row = await upsertSeoPage(getPrisma(), { ...body.data, path }, request.user?.id ?? null);
      await writeAudit({
        action: 'seo.page.upsert',
        resource: 'seo.page',
        resourceId: row.id,
        meta: { path: row.path, noindex: row.noindex },
        ...auditContext(request),
      });
      return { page: toView(row) };
    },
  );

  app.delete(
    '/admin/seo/pages/:id',
    { preHandler: adminOnly, schema: { security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const removed = await deleteSeoPage(getPrisma(), id);
      if (!removed) return reply.code(404).send({ error: '覆写不存在' });
      await writeAudit({
        action: 'seo.page.delete',
        resource: 'seo.page',
        resourceId: id,
        ...auditContext(request),
      });
      return { ok: true };
    },
  );
}
