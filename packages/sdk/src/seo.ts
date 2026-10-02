/**
 * SEO delivery contract (ADR-0011 路由与 SEO).
 *
 * 职责划分：**插件负责内容，平台负责输送**。插件通过扩展点 `seo.provider`
 * 声明「我有哪些公开实体、它们的站点相对 URL 是什么、什么时候更新」；平台
 * （内核 `/seo/*` + 站点源 `apps/web`）负责聚合、去重、按 origin 输出
 * `/sitemap.xml`、`/robots.txt`、`/feed.xml`，并在页面级 metadata 中执行
 * `resolveMeta`。
 *
 * 本文件是**传输无关**的契约：不依赖 Fastify / Next，可被插件后端、内核与
 * web 共同引用。所有 `url` 一律是**站点相对路径**（如 `/blog/hello`），插件
 * 不得自行拼 origin（canonical origin 由 `PlatformInfo.url` 提供）。
 */

/** Sitemap `changefreq` 取值。 */
export type SeoChangeFrequency =
  'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';

/** 一条 hreflang 替代链接（同一实体的其他语言版本）。 */
export interface SeoAlternate {
  /** BCP 47 语言标签，如 `zh-CN` / `en-US` / `x-default`。 */
  hreflang: string;
  /** 站点相对路径或绝对 URL；相对路径由平台按 origin 展开。 */
  href: string;
}

/** 一条 sitemap 条目（实体级；由插件 provider 提供）。 */
export interface SeoUrlEntry {
  /** 站点相对路径，如 `/blog/hello`（不含 origin）。 */
  url: string;
  /** ISO 8601。 */
  lastModified?: string;
  changeFrequency?: SeoChangeFrequency;
  /** 0..1。 */
  priority?: number;
  /** 其他语言版本；用于 hreflang（ADR-0016 A6）。 */
  alternates?: SeoAlternate[];
}

/** 一条 RSS/Atom 条目。 */
export interface SeoFeedEntry {
  url: string;
  title: string;
  /** ISO 8601。 */
  updated: string;
  summary?: string;
  /** HTML。 */
  content?: string;
  author?: string;
}

/** 实体级页面元数据（页面级 metadata 通道）。 */
export interface SeoEntityMeta {
  title?: string;
  description?: string;
  /** 站点相对路径或绝对 URL；缺省时平台按当前路径生成。 */
  canonical?: string;
  noindex?: boolean;
  ogImage?: string;
  /** 其他语言版本（hreflang）；站点源映射为 `<link rel="alternate">`。 */
  alternates?: SeoAlternate[];
  jsonLd?: Record<string, unknown> | Array<Record<string, unknown>>;
}

/**
 * 插件注册到 `seo.provider` 扩展点的实现。
 *
 * 注册方式与 `web.nav` / `ui.admin.dashboard` 一致：
 * `ctx.registerExtension(EXTENSION_POINTS.seoProvider, provider)`。
 */
export interface SeoProvider {
  readonly id: string;
  /**
   * sitemap 条目，逐页提供。必须是**确定、可分页、无副作用**的纯读取；
   * 平台按 `total` 迭代到收敛。
   */
  listEntries(opts: {
    page: number;
    pageSize: number;
  }): Promise<{ entries: SeoUrlEntry[]; total: number }>;
  /** 可选：RSS/Atom 条目。 */
  listFeed?(opts: {
    page: number;
    pageSize: number;
  }): Promise<{ entries: SeoFeedEntry[]; total: number }>;
  /** 可选：给定站点路径解析实体元数据（供页面级 metadata 复用）。 */
  resolveMeta?(input: {
    path: string;
    params: Record<string, string>;
  }): Promise<SeoEntityMeta | null>;
}

/** 内核 `/seo/sitemap` 的条目：附带贡献者归属 `source`。 */
export interface SeoSitemapEntry extends SeoUrlEntry {
  /** 贡献该条目的 provider id（重复 URL 时保留首个）。 */
  source: string;
}

/** 内核 `GET /seo/sitemap?page=&pageSize=` 响应。 */
export interface SeoSitemapPage {
  entries: SeoSitemapEntry[];
  total: number;
  page: number;
  pageSize: number;
}

/** 内核 `GET /seo/feed?page=&pageSize=` 响应。 */
export interface SeoFeedPage {
  entries: SeoFeedEntry[];
  total: number;
  page: number;
  pageSize: number;
}

/** 内核 `GET /seo/meta?path=&params=` 响应。 */
export interface SeoMetaResult {
  meta: SeoEntityMeta | null;
  /** 命中该元数据的 provider id；无命中为 `null`。 */
  source: string | null;
}

/** 一条 robots 规则。 */
export interface SeoRobotsRule {
  userAgent: string;
  allow?: string[];
  disallow?: string[];
}

/** 内核 `GET /seo/robots` 响应（平台站点级策略）。 */
export interface SeoRobots {
  rules: SeoRobotsRule[];
  /** 站点源 sitemap 绝对地址；未配置 origin 时为 `null`。 */
  sitemap: string | null;
}

/** 单次请求允许的最大条目数，保护内核与站点源。 */
export const SEO_MAX_PAGE_SIZE = 200;
/** 单文件 sitemap 的规范上限（超过需演进为 index，本期只设保护）。 */
export const SEO_SITEMAP_URL_LIMIT = 50_000;

/** 平台保留的 URL 前缀，robots 默认 disallow（ADR-0011 §5）。 */
export const SEO_RESERVED_DISALLOW: readonly string[] = [
  '/account/',
  '/admin/',
  '/preview',
  '/auth/',
  '/api/',
  '/login',
  '/register',
];

/** 规范化为以 `/` 开头、无尾斜杠的站点路径；根路径保持 `/`。 */
export function normalizeSeoPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return '/';
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withSlash.length > 1 && withSlash.endsWith('/') ? withSlash.slice(0, -1) : withSlash;
}

/** 把站点相对路径展开为绝对 URL；已是绝对 URL 时原样返回。 */
export function toAbsoluteUrl(origin: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const base = origin.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

/** 把 hreflang 替代链接转成 `Record<hreflang, href>`（Next sitemap 使用）。 */
export function seoAlternatesToLanguages(
  alternates: SeoAlternate[] | undefined,
): Record<string, string> {
  const languages: Record<string, string> = {};
  for (const alternate of alternates ?? []) {
    if (alternate.hreflang && alternate.href) languages[alternate.hreflang] = alternate.href;
  }
  return languages;
}

/**
 * 按 URL 去重，保留**首个**出现者（registration 顺序即 provider 顺序）。
 * 开发者不得依赖重复 URL。
 */
export function dedupeSeoUrlEntries(entries: SeoSitemapEntry[]): SeoSitemapEntry[] {
  const seen = new Set<string>();
  const out: SeoSitemapEntry[] = [];
  for (const entry of entries) {
    const key = normalizeSeoPath(entry.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/**
 * 合并两层元数据：`override` 的每个非空字段覆盖 `base` 同名字段。
 * `jsonLd` 仅在 override 提供时替换，避免把两套结构化数据拼成非法 JSON-LD。
 */
export function mergeSeoMeta(base: SeoEntityMeta, override: SeoEntityMeta | null): SeoEntityMeta {
  if (!override) return { ...base };
  const merged: SeoEntityMeta = { ...base };
  if (override.title !== undefined) merged.title = override.title;
  if (override.description !== undefined) merged.description = override.description;
  if (override.canonical !== undefined) merged.canonical = override.canonical;
  if (override.noindex !== undefined) merged.noindex = override.noindex;
  if (override.ogImage !== undefined) merged.ogImage = override.ogImage;
  if (override.alternates !== undefined) merged.alternates = override.alternates;
  if (override.jsonLd !== undefined) merged.jsonLd = override.jsonLd;
  return merged;
}

/** 结构化类型守卫：判断一个未知值是否满足 {@link SeoProvider}。 */
export function isSeoProvider(value: unknown): value is SeoProvider {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate['id'] !== 'string' || candidate['id'].length === 0) return false;
  if (typeof candidate['listEntries'] !== 'function') return false;
  if (candidate['listFeed'] !== undefined && typeof candidate['listFeed'] !== 'function')
    return false;
  if (candidate['resolveMeta'] !== undefined && typeof candidate['resolveMeta'] !== 'function') {
    return false;
  }
  return true;
}

/** Type-check an {@link SeoProvider} literal (identity helper). */
export function defineSeoProvider(provider: SeoProvider): SeoProvider {
  return provider;
}
