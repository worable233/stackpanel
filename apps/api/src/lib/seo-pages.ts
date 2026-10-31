/**
 * 逐页 SEO 覆写（对标 #12.4）。
 *
 * 分工不变：**内容归属仍在插件**（`seo.provider` 提供实体级 title/描述/JSON-LD），
 * 这里只存运营真正想改的那几个字段。因此覆写是「逐字段压在上面」，不是替换 ——
 * 改一个标题不该顺手把商品的 JSON-LD 也抹掉。
 *
 * 平台默认 → 页面静态声明（主题/插件 manifest）→ provider 实体 → 本覆写，
 * 四层由外到内，越具体越靠后。
 */
import type { PrismaClient } from '@stackpanel/db';
import { normalizeSeoPath, type SeoEntityMeta } from '@stackpanel/sdk';

export const SEO_PAGE_LIMITS = {
  path: 512,
  title: 200,
  description: 500,
  url: 1_000,
} as const;

export interface SeoPageRow {
  id: string;
  path: string;
  title: string | null;
  description: string | null;
  ogImage: string | null;
  canonical: string | null;
  noindex: boolean;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 规范化并校验路径。
 *
 * 把 `?` / `#` 判为非法是刻意的：覆写是按**页面路径**索引的，带 query 的「页面」
 * 会让同一个页面产生无数条记录，运营也永远改不全。
 */
export function normalizeSeoPagePath(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > SEO_PAGE_LIMITS.path) return null;
  if (trimmed.includes('?') || trimmed.includes('#')) return null;
  return normalizeSeoPath(trimmed);
}

/** 分享图 / canonical：要么站内相对路径，要么绝对 http(s) URL。 */
export function isValidSeoPageUrl(value: string): boolean {
  if (value.length === 0 || value.length > SEO_PAGE_LIMITS.url) return false;
  if (value.startsWith('/') && !value.startsWith('//')) return true;
  return /^https?:\/\/[^\s]+$/i.test(value);
}

export function toSeoEntityMeta(row: SeoPageRow): SeoEntityMeta {
  const meta: SeoEntityMeta = {};
  if (row.title) meta.title = row.title;
  if (row.description) meta.description = row.description;
  if (row.ogImage) meta.ogImage = row.ogImage;
  if (row.canonical) meta.canonical = row.canonical;
  // noindex 为 true 才有意义；false 表示「不干预」，不能覆盖 provider 的决定。
  if (row.noindex) meta.noindex = true;
  return meta;
}

export async function getSeoPageByPath(
  db: PrismaClient,
  path: string,
): Promise<SeoPageRow | null> {
  return db.seoPage.findUnique({ where: { path } });
}

export async function listSeoPages(
  db: PrismaClient,
  options: {
    query?: string | undefined;
    page?: number | undefined;
    pageSize?: number | undefined;
  } = {},
): Promise<{ pages: SeoPageRow[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, Math.trunc(options.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Math.trunc(options.pageSize ?? 50)));
  const query = options.query?.trim() ?? '';
  const where = query
    ? {
        OR: [
          { path: { contains: query, mode: 'insensitive' as const } },
          { title: { contains: query, mode: 'insensitive' as const } },
        ],
      }
    : {};
  const [pages, total] = await Promise.all([
    db.seoPage.findMany({
      where,
      orderBy: { path: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.seoPage.count({ where }),
  ]);
  return { pages, total, page, pageSize };
}

export interface SeoPageInput {
  path: string;
  title?: string | null | undefined;
  description?: string | null | undefined;
  ogImage?: string | null | undefined;
  canonical?: string | null | undefined;
  noindex?: boolean | undefined;
}

/** 按路径 upsert：同一页面的覆写只有一条，重复保存是修改而不是新增。 */
export async function upsertSeoPage(
  db: PrismaClient,
  input: SeoPageInput,
  actorId: string | null,
): Promise<SeoPageRow> {
  const path = normalizeSeoPagePath(input.path);
  if (!path) throw new Error('invalid-path');
  const data = {
    title: emptyToNull(input.title),
    description: emptyToNull(input.description),
    ogImage: emptyToNull(input.ogImage),
    canonical: emptyToNull(input.canonical),
    noindex: input.noindex ?? false,
    updatedBy: actorId,
  };
  return db.seoPage.upsert({
    where: { path },
    create: { path, ...data },
    update: data,
  });
}

export async function deleteSeoPage(db: PrismaClient, id: string): Promise<boolean> {
  const { count } = await db.seoPage.deleteMany({ where: { id } });
  return count > 0;
}

/** sitemap 一致性：被判 noindex 的页面不得出现在 sitemap 里。 */
export async function noindexedPaths(
  db: PrismaClient,
  paths: readonly string[],
): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const rows = await db.seoPage.findMany({
    where: { noindex: true, path: { in: [...new Set(paths)] } },
    select: { path: true },
  });
  return new Set(rows.map((row) => row.path));
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
