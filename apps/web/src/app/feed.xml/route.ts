import { toAbsoluteUrl } from '@stackpanel/sdk';
import { getSeoFeed, platformSeoDefaults, resolveSiteOrigin } from '@/lib/seo';

/**
 * `/feed.xml`（ADR-0011 §3）：RSS 2.0。条目由插件的 `seo.provider.listFeed`
 * 贡献，平台聚合、按 origin 展开并序列化。
 */
export const revalidate = 3600;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function GET(): Promise<Response> {
  const [origin, defaults, entries] = await Promise.all([
    resolveSiteOrigin(),
    platformSeoDefaults(),
    getSeoFeed(),
  ]);

  const items = entries
    .map((entry) => {
      const link = toAbsoluteUrl(origin, entry.url);
      return [
        '    <item>',
        `      <title>${escapeXml(entry.title)}</title>`,
        `      <link>${escapeXml(link)}</link>`,
        `      <guid isPermaLink="true">${escapeXml(link)}</guid>`,
        `      <pubDate>${new Date(entry.updated).toUTCString()}</pubDate>`,
        ...(entry.author ? [`      <author>${escapeXml(entry.author)}</author>`] : []),
        ...(entry.summary ? [`      <description>${escapeXml(entry.summary)}</description>`] : []),
        ...(entry.content
          ? [
              `      <content:encoded><![CDATA[${entry.content.replace(/]]>/g, ']]&gt;')}]]></content:encoded>`,
            ]
          : []),
        '    </item>',
      ].join('\n');
    })
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${escapeXml(defaults.name)}</title>
    <link>${escapeXml(origin)}</link>
    <description>${escapeXml(defaults.description)}</description>
    <language>${escapeXml('zh-CN')}</language>
${items}
  </channel>
</rss>
`;

  return new Response(xml, {
    headers: {
      'content-type': 'application/rss+xml; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
}
