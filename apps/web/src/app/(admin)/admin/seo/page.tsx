import { Suspense } from 'react';
import { InlineError, PageHeader } from '@stackpanel/ui';
import { DataSkeleton } from '@/components/data-skeletons';
import { getAuthedApiClient } from '@/lib/api';
import { apiErrorMessage } from '@/lib/api-errors';
import { getLocale } from '@/i18n/locale';
import { createTranslator, type Translator } from '@/i18n/core';
import { SeoPageManager } from '@/components/seo-page-manager';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

/**
 * 逐页 SEO 后台编辑（对标 #12.4）。
 *
 * 这里只改「运营真的会改」的字段：标题、描述、分享图、canonical、noindex。
 * 实体内容仍归插件 `seo.provider`，覆写按字段压在其上。
 */
export default async function AdminSeoPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const t = createTranslator(await getLocale());
  const query = typeof params.query === 'string' ? params.query : '';
  const page = Math.max(1, Number(params.page) || 1);

  return (
    <main className="w-full">
      <PageHeader title={t('adminSeo.title')} />
      <p className="mb-4 text-sm text-muted-foreground">{t('adminSeo.description')}</p>
      <Suspense fallback={<DataSkeleton variant="list" rows={6} />}>
        <SeoData query={query} page={page} t={t} />
      </Suspense>
    </main>
  );
}

async function SeoData({ query, page, t }: { query: string; page: number; t: Translator }) {
  let data: Awaited<
    ReturnType<Awaited<ReturnType<typeof getAuthedApiClient>>['listSeoPages']>
  > | null = null;
  let error: string | null = null;
  try {
    const api = await getAuthedApiClient();
    data = await api.listSeoPages({ query, page, pageSize: PAGE_SIZE });
  } catch (err) {
    error = await apiErrorMessage(err);
  }

  if (error || !data) {
    return <InlineError>{error ?? t('adminSeo.loadFailed')}</InlineError>;
  }

  return (
    <SeoPageManager
      pages={data.pages}
      total={data.total}
      page={data.page}
      pageSize={data.pageSize}
      query={query}
    />
  );
}
