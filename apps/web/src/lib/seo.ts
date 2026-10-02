import 'server-only';
import { cache } from 'react';
import { z } from 'zod';
import type { Metadata } from 'next';
import {
  DEFAULT_PLATFORM_INFO,
  mergeSeoMeta,
  resolveFrontendPageSource,
  selectFrontendPageDefinition,
  toAbsoluteUrl,
  type SeoEntityMeta,
} from '@stackpanel/sdk';
import { getApiClient } from './api';
import { activeThemeCandidate, listPluginFrontendCandidates } from './slots';

/**
 * 站点源 SEO 输送（ADR-0011 §3–§4）。
 *
 * 站点源（web）与内核 `/seo/*` 一一对应，负责把聚合数据序列化为
 * `/sitemap.xml`、`/robots.txt`、`/feed.xml`，并在页面 `generateMetadata` 中
 * 合并「平台默认 + 页面静态声明 + 实体级 provider」。所有 origin 取
 * `PlatformInfo.url`（ADR-0011 §7）。
 */

const alternateSchema = z.object({ hreflang: z.string(), href: z.string() });

const seoMetaSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  canonical: z.string().optional(),
  noindex: z.boolean().optional(),
  ogImage: z.string().optional(),
  alternates: z.array(alternateSchema).optional(),
  jsonLd: z
    .union([z.record(z.string(), z.unknown()), z.array(z.record(z.string(), z.unknown()))])
    .optional(),
});

const metaResultSchema = z.object({
  meta: seoMetaSchema.nullable(),
  source: z.string().nullable(),
});

const sitemapEntrySchema = z.object({
  url: z.string(),
  lastModified: z.string().optional(),
  changeFrequency: z
    .enum(['always', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'never'])
    .optional(),
  priority: z.number().optional(),
  alternates: z.array(alternateSchema).optional(),
  source: z.string(),
});

const sitemapPageSchema = z.object({
  entries: z.array(sitemapEntrySchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});

const feedEntrySchema = z.object({
  url: z.string(),
  title: z.string(),
  updated: z.string(),
  summary: z.string().optional(),
  content: z.string().optional(),
  author: z.string().optional(),
});

const feedPageSchema = z.object({
  entries: z.array(feedEntrySchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});

const robotsSchema = z.object({
  rules: z.array(
    z.object({
      userAgent: z.string(),
      allow: z.array(z.string()).optional(),
      disallow: z.array(z.string()).optional(),
    }),
  ),
  sitemap: z.string().nullable(),
});

export type SeoSitemapEntry = z.infer<typeof sitemapEntrySchema>;
export type SeoFeedEntry = z.infer<typeof feedEntrySchema>;
export type SeoRobots = z.infer<typeof robotsSchema>;

/**
 * Canonical origin：优先 `PlatformInfo.url`（生产必须配置），其次 `SITE_URL`，
 * 最后回退到本地开发地址。所有绝对 URL（canonical/hreflang/sitemap）都以它为准。
 */
export async function resolveSiteOrigin(): Promise<string> {
  const platform = await getApiClient()
    .getPlatformInfo()
    .then((result) => result.platform)
    .catch(() => DEFAULT_PLATFORM_INFO);
  const configured = platform.url ?? process.env.SITE_URL ?? null;
  return (configured ?? 'http://localhost:3000').replace(/\/+$/, '');
}

/** 平台默认站点级 metadata（根布局已设置，这里用于合并底线）。 */
export async function platformSeoDefaults(): Promise<{
  name: string;
  description: string;
  origin: string;
}> {
  const platform = await getApiClient()
    .getPlatformInfo()
    .then((result) => result.platform)
    .catch(() => DEFAULT_PLATFORM_INFO);
  return {
    name: platform.name,
    description: platform.description,
    origin: (platform.url ?? process.env.SITE_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
  };
}

/** 解析当前路径命中的页面静态 `meta` 声明（主题优先，其次插件）。 */
async function staticPageMeta(path: string): Promise<SeoEntityMeta> {
  try {
    const [theme, plugins] = await Promise.all([
      activeThemeCandidate(),
      listPluginFrontendCandidates(),
    ]);
    const themePages = theme?.manifest.pages ?? [];
    const pluginPages = plugins.flatMap((candidate) => candidate.manifest.pages ?? []);
    const source = resolveFrontendPageSource(themePages, pluginPages, path);
    const pages = source === 'theme' ? themePages : source === 'plugin' ? pluginPages : [];
    return selectFrontendPageDefinition(pages, path)?.meta ?? {};
  } catch {
    return {};
  }
}

/** 逐 provider 询问实体级元数据（内核取首个非空结果）。 */
async function entityMeta(path: string, params: Record<string, string>): Promise<SeoEntityMeta> {
  try {
    const query = new URLSearchParams({ path });
    if (Object.keys(params).length > 0) query.set('params', JSON.stringify(params));
    const result = await getApiClient().get(`/seo/meta?${query.toString()}`, metaResultSchema);
    return result.meta ?? {};
  } catch {
    return {};
  }
}

/**
 * 页面 SEO 元数据：静态声明为底、实体级 provider 覆盖（ADR-0011 §4）。
 * 用 React `cache` 去重，使 `generateMetadata` 与 JSON-LD 组件在同一请求内
 * 只解析一次。
 */
export const resolvePageSeo = cache(
  async (path: string, paramsJson: string): Promise<SeoEntityMeta> => {
    const params = JSON.parse(paramsJson) as Record<string, string>;
    const [base, override] = await Promise.all([staticPageMeta(path), entityMeta(path, params)]);
    return mergeSeoMeta(base, override);
  },
);

/** 把合并后的 SEO 元数据映射为 Next `Metadata`（含 canonical 与 hreflang）。 */
export function toNextMetadata(meta: SeoEntityMeta, origin: string, path: string): Metadata {
  const languages: Record<string, string> = {};
  for (const alternate of meta.alternates ?? []) {
    languages[alternate.hreflang] = toAbsoluteUrl(origin, alternate.href);
  }
  const canonical = toAbsoluteUrl(origin, meta.canonical ?? path);
  const metadata: Metadata = {
    metadataBase: new URL(origin),
    alternates: {
      canonical,
      ...(Object.keys(languages).length > 0 ? { languages } : {}),
    },
  };
  if (meta.title) metadata.title = meta.title;
  if (meta.description) metadata.description = meta.description;
  if (meta.noindex !== undefined) {
    metadata.robots = { index: !meta.noindex, follow: !meta.noindex };
  }
  if (meta.ogImage) {
    metadata.openGraph = { images: [toAbsoluteUrl(origin, meta.ogImage)] };
  }
  return metadata;
}

/** 聚合后的 sitemap 条目；内核不可达时返回空，绝不让站点源 500。 */
export async function getSeoSitemap(): Promise<SeoSitemapEntry[]> {
  try {
    const page = await getApiClient().get('/seo/sitemap?pageSize=200', sitemapPageSchema);
    return page.entries;
  } catch {
    return [];
  }
}

/** 聚合后的 feed 条目。 */
export async function getSeoFeed(): Promise<SeoFeedEntry[]> {
  try {
    const page = await getApiClient().get('/seo/feed?pageSize=200', feedPageSchema);
    return page.entries;
  } catch {
    return [];
  }
}

/** 平台 robots 策略；内核不可达时回退为仅禁止保留路径。 */
export async function getSeoRobots(): Promise<SeoRobots> {
  try {
    return await getApiClient().get('/seo/robots', robotsSchema);
  } catch {
    return {
      rules: [
        {
          userAgent: '*',
          allow: ['/'],
          disallow: ['/account/', '/admin/', '/preview', '/auth/', '/api/'],
        },
      ],
      sitemap: null,
    };
  }
}
