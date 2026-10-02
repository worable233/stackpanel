import type { Metadata } from 'next';
import { FrontendRoute } from '@/components/frontend-route';
import { JsonLd } from '@/components/json-ld';
import { resolvePageSeo, resolveSiteOrigin, toNextMetadata } from '@/lib/seo';

export const dynamic = 'force-dynamic';

/** Generic public route host. Themes and plugins own the rendered experience. */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const query = await searchParams;
  const error = query.error;
  const meta = await resolvePageSeo('/', JSON.stringify({}));
  return (
    <>
      <JsonLd meta={meta} />
      <FrontendRoute
        path="/"
        searchParams={query}
        actionError={
          typeof error === 'string' && error.length > 0 && error.length <= 256 ? error : undefined
        }
      />
    </>
  );
}

export async function generateMetadata(): Promise<Metadata> {
  const [meta, origin] = await Promise.all([resolvePageSeo('/', '{}'), resolveSiteOrigin()]);
  return toNextMetadata(meta, origin, '/');
}
