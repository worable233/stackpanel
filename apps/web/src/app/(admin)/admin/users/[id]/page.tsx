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
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ orderPage?: string; orderPageSize?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const orderPage = Math.floor(Math.min(1000000, Math.max(1, Number(query.orderPage) || 1)));
  const orderPageSize = [10, 20, 50, 100].includes(Number(query.orderPageSize)) ? Number(query.orderPageSize) : 20;
  const t = createTranslator(await getLocale());
  const client = await getAuthedApiClient();

  let detail: AdminUserDetailResponse | null = null;
  let groups: PermissionGroupListResponse | null = null;
  let error: string | null = null;

  try {
    [detail, groups] = await Promise.all([
      client.getAdminUser(id, { orderPage, orderPageSize }),
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
          <span className="flex min-w-0 items-start gap-2">
            <UserRoundCog className="mt-1 size-6 shrink-0 text-primary" />
            <span className="min-w-0 break-all">{detail.user.email}</span>
          </span>
        }
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
