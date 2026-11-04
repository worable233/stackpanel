import { Suspense, cache } from 'react';
import type { PermissionGroupInfo } from '@stackpanel/sdk';
import { PageHeader } from '@stackpanel/ui';
import { DataSkeleton } from '@/components/data-skeletons';
import { CreateUserForm } from '@/components/create-user-form';
import { getAuthedApiClient } from '@/lib/api';
import { apiErrorMessage } from '@/lib/api-errors';
import { getLocale } from '@/i18n/locale';
import { createTranslator, type Translator } from '@/i18n/core';
import { Skeleton } from '@/components/ui/skeleton';
import { UsersManager } from './users-manager';

export const dynamic = 'force-dynamic';

const DEFAULT_PAGE_SIZE = 20;
const SORT_VALUES = [
  'createdAt_desc',
  'createdAt_asc',
  'balance_desc',
  'balance_asc',
  'lastLoginAt_desc',
  'lastLoginAt_asc',
] as const;
const STATUS_VALUES = ['ACTIVE', 'DISABLED'] as const;

type StatusFilter = 'all' | (typeof STATUS_VALUES)[number];
type UserSort = (typeof SORT_VALUES)[number];

const getGroups = cache(async (): Promise<PermissionGroupInfo[]> => {
  try {
    return (await (await getAuthedApiClient()).getPermissionGroups()).groups;
  } catch {
    return [];
  }
});

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);
  const q = typeof params.q === 'string' ? params.q.trim() : '';
  const rawStatus = typeof params.status === 'string' ? params.status : '';
  const status = (STATUS_VALUES as readonly string[]).includes(rawStatus)
    ? (rawStatus as StatusFilter)
    : 'all';
  const groupId = typeof params.groupId === 'string' ? params.groupId : '';
  const sort = SORT_VALUES.find((value) => value === params.sort) ?? 'createdAt_desc';
  const parsedPageSize = Number(params.pageSize);
  const pageSize = [10, 20, 30, 50].includes(parsedPageSize) ? parsedPageSize : DEFAULT_PAGE_SIZE;
  const t = createTranslator(await getLocale());

  return (
    <main className="flex w-full flex-col gap-4">
      <PageHeader
        title={t('admin.users.title')}
        actions={
          <Suspense fallback={<Skeleton className="h-9 w-24 rounded-xl" />}>
            <CreateUserAction />
          </Suspense>
        }
      />
      <Suspense fallback={<DataSkeleton variant="table" rows={8} />}>
        <UsersData
          page={page}
          pageSize={pageSize}
          q={q}
          status={status}
          groupId={groupId}
          sort={sort}
          t={t}
        />
      </Suspense>
    </main>
  );
}

async function CreateUserAction() {
  const groups = await getGroups();
  return <CreateUserForm groups={groups} />;
}

async function UsersData({
  page,
  pageSize,
  q,
  status,
  groupId,
  sort,
  t,
}: {
  page: number;
  pageSize: number;
  q: string;
  status: StatusFilter;
  groupId: string;
  sort: UserSort;
  t: Translator;
}) {
  let users: Awaited<
    ReturnType<Awaited<ReturnType<typeof getAuthedApiClient>>['listAdminUsers']>
  > | null = null;
  let error: string | null = null;
  try {
    const [usersResult, groups] = await Promise.all([
      (await getAuthedApiClient()).listAdminUsers({
        page,
        pageSize,
        sort,
        ...(q ? { q } : {}),
        ...(status !== 'all' ? { status } : {}),
        ...(groupId ? { groupId } : {}),
      }),
      getGroups(),
    ]);
    users = usersResult;
    return (
      <UsersManager
        users={users.users}
        total={users.total}
        page={users.page}
        pageSize={users.pageSize}
        q={q}
        status={status}
        groupId={groupId}
        sort={sort}
        groups={groups}
        error={error}
      />
    );
  } catch (err) {
    error = await apiErrorMessage(err);
    return (
      <UsersManager
        users={[]}
        total={0}
        page={page}
        pageSize={pageSize}
        q={q}
        status={status}
        groupId={groupId}
        sort={sort}
        groups={[]}
        error={error}
      />
    );
  }
}
