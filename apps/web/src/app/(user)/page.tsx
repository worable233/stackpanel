import type { Metadata } from 'next';
import { FrontendRoute } from '@/components/frontend-route';
import { JsonLd } from '@/components/json-ld';
import { resolvePageSeo, resolveSiteOrigin, toNextMetadata } from '@/lib/seo';
import { stripFeedbackParams } from '@/lib/feedback-params';

export const dynamic = 'force-dynamic';

/** Generic public route host. Themes and plugins own the rendered experience. */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const meta = await resolvePageSeo('/', JSON.stringify({}));
  return (
    <>
      <JsonLd meta={meta} />
      {/* 同 `(user)/[...slug]`：宿主反馈参数不传给插件页面。 */}
      <FrontendRoute path="/" searchParams={stripFeedbackParams(query)} />
    </>
  );
}

export async function generateMetadata(): Promise<Metadata> {
  const [meta, origin] = await Promise.all([resolvePageSeo('/', '{}'), resolveSiteOrigin()]);
  return toNextMetadata(meta, origin, '/');
}
