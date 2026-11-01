import type { Metadata } from 'next';
import { FrontendRoute } from '@/components/frontend-route';
import { JsonLd } from '@/components/json-ld';
import { resolvePageSeo, resolveSiteOrigin, toNextMetadata } from '@/lib/seo';
import { stripFeedbackParams } from '@/lib/feedback-params';

export const dynamic = 'force-dynamic';

/** Theme/plugin-defined user pages that have no built-in Next route shell. */
export default async function UserThemeRoute({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const path = `/${slug.join('/')}`;
  const meta = await resolvePageSeo(path, JSON.stringify({}));
  return (
    <>
      <JsonLd meta={meta} />
      {/* `error` / `success` / `flash` 属于宿主反馈通道，不进插件页面：
          否则插件可以把 URL 里的任意文本渲染成自己的界面文案。 */}
      <FrontendRoute path={path} searchParams={stripFeedbackParams(query)} />
    </>
  );
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const path = `/${slug.join('/')}`;
  const [meta, origin] = await Promise.all([
    resolvePageSeo(path, JSON.stringify({})),
    resolveSiteOrigin(),
  ]);
  return toNextMetadata(meta, origin, path);
}

