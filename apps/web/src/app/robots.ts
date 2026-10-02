import type { MetadataRoute } from 'next';
import { getSeoRobots, resolveSiteOrigin } from '@/lib/seo';

/**
 * `/robots.txt`（ADR-0011 §3/§5）。规则来自平台 `/seo/robots`，
 * sitemap 地址按 origin 展开。
 */
export const revalidate = 3600;

export default async function robots(): Promise<MetadataRoute.Robots> {
  const [origin, config] = await Promise.all([resolveSiteOrigin(), getSeoRobots()]);
  return {
    rules: config.rules.map((rule) => ({
      userAgent: rule.userAgent,
      ...(rule.allow ? { allow: rule.allow } : {}),
      ...(rule.disallow ? { disallow: rule.disallow } : {}),
    })),
    sitemap: config.sitemap ?? `${origin}/sitemap.xml`,
  };
}
