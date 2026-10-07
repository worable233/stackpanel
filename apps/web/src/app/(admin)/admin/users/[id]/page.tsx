import Link from 'next/link';
import { ArrowLeft, UserRoundCog } from 'lucide-react';
import type { AdminUserDetailResponse, PermissionGroupListResponse } from '@stackpanel/sdk';
import { PageHeader } from '@stackpanel/ui';
import { getAuthedApiClient } from '@/lib/api';
import { apiErrorMessage } from '@/lib/api-errors';
import { impersonateUserAction } from '@/lib/user-actions';
import { AdminUserDetail } from '@/components/admin-user-detail';
import { Button } from '@/components/ui/button';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';

export const dynamic = 'force-dynamic';

export default async function AdminUserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const t = createTranslator(await getLocale());
  const client = await getAuthedApiClient();

  let detail: AdminUserDetailResponse | null = null;
  let groups: PermissionGroupListResponse | null = null;
  let error: string | null = null;

  try {
    [detail, groups] = await Promise.all([
      client.getAdminUser(id),
      client.getPermissionGroups(),
    ]);
  } catch (err) {
    error = await apiErrorMessage(err);
  }

  if (error || !detail) {
    return (
      <main className="space-y-4">
        <Button render={<Link href="/admin/users" />} variant="ghost" size="sm" className="w-fit">
          <ArrowLeft className="size-4" />
          {t('admin.userDetailPage.backToUsers')}
        </Button>
        <p className="text-sm text-destructive">
          {error ?? t('admin.userDetailPage.notFound')}
        </p>
      </main>
    );
  }

  return (
    <main className="space-y-5">
      <PageHeader
        eyebrow={
          <Link
            href="/admin/users"
            className="mb-1 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            {t('admin.userDetailPage.backToUsers')}
          </Link>
        }
        title={
          <span className="flex items-center gap-2">
            <UserRoundCog className="size-6 text-primary" />
            {detail.user.email}
          </span>
        }
        description={t('admin.userDetailPage.description')}
        actions={
          <form action={impersonateUserAction.bind(null, id)}>
            <Button type="submit">{t('admin.userDetailPage.impersonate')}</Button>
          </form>
        }
      />

      <AdminUserDetail
        userId={id}
        initial={detail}
        groups={groups?.groups ?? []}
      />
    </main>
  );
}
