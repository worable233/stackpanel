import { Suspense, cache } from 'react';
import type { PermissionGroupInfo } from '@stackpanel/sdk';
import { PageHeader } from '@stackpanel/ui';
import { DataSkeleton } from '@/components/data-skeletons';
import { CreateUserForm } from '@/components/create-user-form';
import { getAuthedApiClient } from '@/lib/api';
import { apiErrorMessage } from '@/lib/api-errors';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';
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
}: {
  page: number;
  pageSize: number;
  q: string;
  status: StatusFilter;
  groupId: string;
  sort: UserSort;
}) {
  type UsersPage = Awaited<
    ReturnType<Awaited<ReturnType<typeof getAuthedApiClient>>['listAdminUsers']>
  >;
  type Groups = Awaited<ReturnType<typeof getGroups>>;

  /**
   * 只把**取数**包在 try/catch 里，JSX 放在外面。
   *
   * 原写法把 `<UsersManager …>` 也写在 try 内。即使在 async 服务端组件里
   * 构造元素本身是同步的，这个结构仍然容易被误读成「渲染错误会被捕获」——
   * 实际不会：子组件的渲染发生在之后，崩溃照样冒泡。lint 规则
   * `react-hooks/error-boundaries` 正是按这个语义报警。
   *
   * 分开之后语义明确：catch 只负责把 API 失败转成错误文案（降级为空列表），
   * 渲染错误交给上层的 error boundary。
   */
  let users: UsersPage | null = null;
  let groups: Groups = [];
  let error: string | null = null;
  try {
    [users, groups] = await Promise.all([
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
  } catch (err) {
    error = await apiErrorMessage(err);
  }

  return (
    <UsersManager
      users={users?.users ?? []}
      total={users?.total ?? 0}
      page={users?.page ?? page}
      pageSize={users?.pageSize ?? pageSize}
      q={q}
      status={status}
      groupId={groupId}
      sort={sort}
      groups={groups}
      error={error}
    />
  );
}
