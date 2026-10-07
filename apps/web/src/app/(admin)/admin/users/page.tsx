import type { PermissionGroupListResponse, UserListResponse } from '@stackpanel/sdk';
import { getAuthedApiClient } from '@/lib/api';
import { apiErrorMessage } from '@/lib/api-errors';
import { UsersManager } from './users-manager';

export const dynamic = 'force-dynamic';

const DEFAULT_PAGE_SIZE = 20;
const STATUS_VALUES = ['ACTIVE', 'DISABLED'] as const;

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
    ? (rawStatus as (typeof STATUS_VALUES)[number])
    : 'all';
  const groupId = typeof params.groupId === 'string' ? params.groupId : '';
  const parsedPageSize = Number(params.pageSize);
  const pageSize = [10, 20, 30, 50].includes(parsedPageSize) ? parsedPageSize : DEFAULT_PAGE_SIZE;

  const client = await getAuthedApiClient();
  let users: UserListResponse | null = null;
  let groups: PermissionGroupListResponse | null = null;
  let error: string | null = null;
  try {
    [users, groups] = await Promise.all([
      client.listAdminUsers({
        page,
        pageSize,
        ...(q ? { q } : {}),
        ...(status !== 'all' ? { status } : {}),
        ...(groupId ? { groupId } : {}),
      }),
      client.getPermissionGroups(),
    ]);
  } catch (err) {
    error = await apiErrorMessage(err);
  }

  return (
    <main className="w-full">
      <UsersManager
        users={users?.users ?? []}
        total={users?.total ?? 0}
        page={users?.page ?? page}
        pageSize={users?.pageSize ?? pageSize}
        q={q}
        status={status}
        groupId={groupId}
        groups={groups?.groups ?? []}
        error={error}
      />
    </main>
  );
}
