import type { MetadataRoute } from 'next';
import { seoAlternatesToLanguages, toAbsoluteUrl } from '@stackpanel/sdk';
import { getSeoSitemap, resolveSiteOrigin } from '@/lib/seo';

/**
 * `/sitemap.xml`（ADR-0011 §3）。平台聚合并按 origin 输出；插件负责内容。
 * 响应默认缓存（`revalidate` 3600s），与内核 `/seo/sitemap` 的 `Cache-Control` 对齐。
 */
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [origin, entries] = await Promise.all([resolveSiteOrigin(), getSeoSitemap()]);
  return entries.map((entry) => {
    const languages = seoAlternatesToLanguages(entry.alternates);
    const absoluteLanguages: Record<string, string> = {};
    for (const [hreflang, href] of Object.entries(languages)) {
      absoluteLanguages[hreflang] = toAbsoluteUrl(origin, href);
    }
    return {
      url: toAbsoluteUrl(origin, entry.url),
      ...(entry.lastModified ? { lastModified: entry.lastModified } : {}),
      ...(entry.changeFrequency ? { changeFrequency: entry.changeFrequency } : {}),
      ...(entry.priority !== undefined ? { priority: entry.priority } : {}),
      ...(Object.keys(absoluteLanguages).length > 0
        ? { alternates: { languages: absoluteLanguages } }
        : {}),
    };
  });
}
