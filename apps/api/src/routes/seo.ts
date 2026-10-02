import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  EXTENSION_POINTS,
  SEO_MAX_PAGE_SIZE,
  SEO_RESERVED_DISALLOW,
  SEO_SITEMAP_URL_LIMIT,
  dedupeSeoUrlEntries,
  isSeoProvider,
  normalizeSeoPath,
  type SeoFeedEntry,
  type SeoProvider,
  type SeoRobots,
  type SeoSitemapEntry,
} from '@stackpanel/sdk';
import { getPlatformInfo } from '../lib/platform-info.ts';

/**
 * SEO 输送端点（ADR-0011 §3）。
 *
 * 平台只做**聚合与输送**：内容归属与公开 URL 由插件的 `seo.provider` 决定，
 * 内核不感知任何业务实体。四个端点均为只读、公开、可缓存：
 *
 *   GET /seo/sitemap?page=&pageSize=  聚合后的 sitemap 条目（含 source 归属）
 *   GET /seo/feed?page=&pageSize=     聚合后的 feed 条目
 *   GET /seo/meta?path=&params=       逐 provider 询问 resolveMeta，返回首个非空结果
 *   GET /seo/robots                   平台默认 robots 指令 + sitemap 地址
 *
 * 站点源（apps/web）以同源文件落地并拉取这些端点，见 `apps/web/src/app/sitemap.ts`。
 */

/** 一次聚合允许读取的条目上限（保护内核与站点源）。 */
const AGGREGATE_LIMIT = SEO_SITEMAP_URL_LIMIT;

interface Pagination {
  page: number;
  pageSize: number;
}

function parsePagination(query: Record<string, unknown>): Pagination {
  const page = Math.max(1, Math.trunc(Number(query['page']) || 1));
  const pageSize = Math.min(
    SEO_MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(Number(query['pageSize']) || SEO_MAX_PAGE_SIZE)),
  );
  return { page, pageSize };
}

/** 解析 `?params=`（JSON 编码的 `Record<string,string>`）。 */
function parseParams(raw: unknown): Record<string, string> {
  if (typeof raw !== 'string' || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** 只保留合法 sitemap 条目：非空相对/绝对 url。 */
function isSitemapEntry(value: unknown): value is SeoSitemapEntry {
  if (!value || typeof value !== 'object') return false;
  const url = (value as { url?: unknown }).url;
  return typeof url === 'string' && url.trim().length > 0;
}

/**
 * 读取一个 provider 的全部 sitemap 条目（可分页迭代到收敛）。provider 必须是
 * 确定性纯读取；这里仍设硬上限，任何单 provider 的 runaway 都不会拖垮端点。
 */
async function collectSitemapFromProvider(provider: SeoProvider): Promise<SeoSitemapEntry[]> {
  const out: SeoSitemapEntry[] = [];
  let page = 1;
  for (;;) {
    const result = await provider.listEntries({ page, pageSize: SEO_MAX_PAGE_SIZE });
    for (const entry of result.entries ?? []) {
      if (isSitemapEntry(entry)) out.push({ ...entry, source: provider.id });
    }
    const total = Number(result.total) || 0;
    if (out.length >= AGGREGATE_LIMIT) break;
    if (out.length >= total || (result.entries ?? []).length === 0) break;
    page += 1;
  }
  return out.slice(0, AGGREGATE_LIMIT);
}

/** 读取一个 provider 的全部 feed 条目。 */
async function collectFeedFromProvider(provider: SeoProvider): Promise<SeoFeedEntry[]> {
  if (!provider.listFeed) return [];
  const out: SeoFeedEntry[] = [];
  let page = 1;
  for (;;) {
    const result = await provider.listFeed({ page, pageSize: SEO_MAX_PAGE_SIZE });
    for (const entry of result.entries ?? []) {
      if (entry && typeof entry.url === 'string' && typeof entry.title === 'string') {
        out.push(entry);
      }
    }
    const total = Number(result.total) || 0;
    if (out.length >= AGGREGATE_LIMIT) break;
    if (out.length >= total || (result.entries ?? []).length === 0) break;
    page += 1;
  }
  return out.slice(0, AGGREGATE_LIMIT);
}

function paginate<T>(items: T[], { page, pageSize }: Pagination): { items: T[]; total: number } {
  const total = items.length;
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), total };
}

/** 公开、只读的 SEO 聚合端点。接线见 `app.ts`（一行注册）。 */
export async function seoRoutes(app: FastifyInstance): Promise<void> {
  const providers = (): SeoProvider[] =>
    app.pluginRuntime
      .getExtensionsWithOwner<SeoProvider>(EXTENSION_POINTS.seoProvider)
      .map((entry) => entry.implementation)
      .filter(isSeoProvider);

  app.get('/seo/sitemap', async (request, reply) => {
    cache(reply);
    const pagination = parsePagination(request.query as Record<string, unknown>);
    const providerList = providers();
    const collected = (
      await Promise.all(providerList.map((provider) => collectSitemapFromProvider(provider)))
    ).flat();
    const deduped = dedupeSeoUrlEntries(collected).sort((a, b) =>
      normalizeSeoPath(a.url).localeCompare(normalizeSeoPath(b.url)),
    );
    const { items, total } = paginate(deduped, pagination);
    return { entries: items, total, page: pagination.page, pageSize: pagination.pageSize };
  });

  app.get('/seo/feed', async (request, reply) => {
    cache(reply);
    const pagination = parsePagination(request.query as Record<string, unknown>);
    const providerList = providers();
    const collected = (
      await Promise.all(providerList.map((provider) => collectFeedFromProvider(provider)))
    ).flat();
    const sorted = collected.sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));
    const { items, total } = paginate(sorted, pagination);
    return { entries: items, total, page: pagination.page, pageSize: pagination.pageSize };
  });

  app.get('/seo/meta', async (request, reply) => {
    cache(reply);
    const query = request.query as Record<string, unknown>;
    const path = typeof query['path'] === 'string' ? query['path'] : '';
    if (!path) return reply.code(400).send({ error: '缺少 path 参数' });
    const params = parseParams(query['params']);
    for (const provider of providers()) {
      if (!provider.resolveMeta) continue;
      const meta = await provider.resolveMeta({ path: normalizeSeoPath(path), params });
      if (meta) return { meta, source: provider.id };
    }
    return { meta: null, source: null };
  });

  app.get('/seo/robots', async (_request, reply) => {
    cache(reply);
    const platform = await getPlatformInfo();
    const origin = platform.url ? platform.url.replace(/\/+$/, '') : null;
    const robots: SeoRobots = {
      rules: [{ userAgent: '*', allow: ['/'], disallow: [...SEO_RESERVED_DISALLOW] }],
      sitemap: origin ? `${origin}/sitemap.xml` : null,
    };
    return robots;
  });
}

function cache(reply: FastifyReply): void {
  reply.header('Cache-Control', 'public, max-age=3600');
}

export default seoRoutes;
