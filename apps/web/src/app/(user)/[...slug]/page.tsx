import type { Metadata } from 'next';
import { FrontendRoute } from '@/components/frontend-route';
import { JsonLd } from '@/components/json-ld';
import { resolvePageSeo, resolveSiteOrigin, toNextMetadata } from '@/lib/seo';

export const dynamic = 'force-dynamic';

/** Theme/plugin-defined user pages that have no built-in Next route shell. */
export default async function UserThemeRoute({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string[] }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const path = `/${slug.join('/')}`;
  const meta = await resolvePageSeo(path, JSON.stringify({}));
  return (
    <>
      <JsonLd meta={meta} />
      <FrontendRoute path={path} searchParams={query} actionError={readActionError(query.error)} />
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

function readActionError(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined;
}
