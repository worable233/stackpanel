import Link from 'next/link';
import { userListResponseSchema } from '@stackpanel/sdk';
import type { PermissionGroupListResponse, UserListResponse } from '@stackpanel/sdk';
import { PageHeader } from '@stackpanel/ui';
import { getAuthedApiClient } from '@/lib/api';
import { apiErrorMessage } from '@/lib/api-errors';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CreateUserForm } from '@/components/create-user-form';
import { getLocale } from '@/i18n/locale';
import { createTranslator, formatDate } from '@/i18n/core';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const locale = await getLocale();
  const t = createTranslator(locale);
  const page = Math.max(1, Number(params.page) || 1);
  const q = typeof params.q === 'string' ? params.q.trim() : '';

  const client = await getAuthedApiClient();
  let users: UserListResponse | null = null;
  let groups: PermissionGroupListResponse | null = null;
  let error: string | null = null;
  try {
    [users, groups] = await Promise.all([
      client.get(
        `/admin/users?page=${page}&pageSize=${PAGE_SIZE}${q ? `&q=${encodeURIComponent(q)}` : ''}`,
        userListResponseSchema,
      ),
      client.getPermissionGroups(),
    ]);
  } catch (err) {
    error = await apiErrorMessage(err);
  }

  const totalPages = users ? Math.max(1, Math.ceil(users.total / PAGE_SIZE)) : 1;
  const hrefFor = (nextPage: number) => {
    const search = new URLSearchParams();
    if (q) search.set('q', q);
    if (nextPage > 1) search.set('page', String(nextPage));
    const qs = search.toString();
    return qs ? `/admin/users?${qs}` : '/admin/users';
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('admin.users.title')}
        description={t('admin.users.description')}
        actions={<CreateUserForm groups={groups?.groups ?? []} />}
      />

      <form method="get" action="/admin/users" className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Input
            id="q"
            name="q"
            defaultValue={q}
            placeholder={t('admin.users.searchPlaceholder')}
            className="w-72"
            aria-label={t('admin.users.searchAria')}
          />
        </div>
        <Button type="submit" className="w-fit">
          {t('common.search')}
        </Button>
        {q ? (
          <Button render={<Link href="/admin/users" />} variant="outline" className="w-fit">
            {t('common.reset')}
          </Button>
        ) : null}
      </form>

      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('admin.users.colEmail')}</th>
                <th className="px-4 py-2 font-medium">{t('admin.users.colGroups')}</th>
                <th className="px-4 py-2 font-medium">{t('admin.users.colStatus')}</th>
                <th className="px-4 py-2 font-medium">{t('admin.users.colLastLogin')}</th>
              </tr>
            </thead>
            <tbody>
              {users?.users.map((user) => (
                <tr key={user.id} className="border-t transition-colors hover:bg-muted/40">
                  <td className="px-4 py-2">
                    <Link
                      href={`/admin/users/${user.id}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {user.email}
                    </Link>
                  </td>
                  <td className="px-4 py-2">
                    {user.groups.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {user.groups.map((group) => (
                          <span
                            key={group.id}
                            className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground"
                          >
                            {group.name}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {user.status === 'ACTIVE'
                      ? t('common.statusActive')
                      : t('common.statusDisabled')}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {user.lastLoginAt
                      ? formatDate(new Date(user.lastLoginAt), locale, {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {users && users.total === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              {q ? t('admin.users.emptyQuery', { q }) : t('admin.users.empty')}
            </p>
          ) : null}
        </div>
      )}

      {users && users.total > 0 ? (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {t('common.pagination', {
              total: users.total,
              page: users.page,
              pages: totalPages,
            })}
          </span>
          <div className="flex items-center gap-2">
            {page > 1 ? (
              <Button render={<Link href={hrefFor(page - 1)} />} variant="outline" size="sm">
                {t('common.prevPage')}
              </Button>
            ) : (
              <span className="inline-flex h-7 items-center rounded-lg px-2.5 text-xs text-muted-foreground/60">
                {t('common.prevPage')}
              </span>
            )}
            {page < totalPages ? (
              <Button render={<Link href={hrefFor(page + 1)} />} variant="outline" size="sm">
                {t('common.nextPage')}
              </Button>
            ) : (
              <span className="inline-flex h-7 items-center rounded-lg px-2.5 text-xs text-muted-foreground/60">
                {t('common.nextPage')}
              </span>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
