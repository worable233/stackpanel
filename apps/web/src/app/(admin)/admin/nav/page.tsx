import { InlineError, PageHeader } from '@stackpanel/ui';
import { AdminNavManager } from '@/components/admin-nav-manager';
import { getAuthedApiClient } from '@/lib/api';
import { apiErrorMessage } from '@/lib/api-errors';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';

export const dynamic = 'force-dynamic';

/**
 * 后台菜单编辑（对标 #12.3）。
 *
 * 目前只开放 admin 区域：账户区与公开区的菜单分别由内核默认项和主题决定，
 * 运营改它们的动机还不明确，先不给出入口，避免「能改但没人负责」。
 */
export default async function AdminNavPage() {
  const t = createTranslator(await getLocale());

  let items: Awaited<ReturnType<Awaited<ReturnType<typeof getAuthedApiClient>>['getAdminNav']>>['items'] =
    [];
  let error: string | null = null;
  try {
    const api = await getAuthedApiClient();
    const result = await api.getAdminNav('admin');
    items = result.items;
  } catch (err) {
    error = await apiErrorMessage(err);
  }

  return (
    <main className="w-full">
      <PageHeader title={t('adminNav.title')} />
      <p className="mb-4 text-sm text-muted-foreground">{t('adminNav.description')}</p>
      {error ? (
        <InlineError>{error}</InlineError>
      ) : (
        <AdminNavManager surface="admin" items={items} />
      )}
    </main>
  );
}
