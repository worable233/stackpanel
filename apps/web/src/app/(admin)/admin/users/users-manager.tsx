'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { MoreHorizontal, Search } from 'lucide-react';
import type { AdminUser, PermissionGroupInfo } from '@stackpanel/sdk';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@/components/ui/input-group';
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination';
import { PageHeader } from '@stackpanel/ui';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CreateUserForm } from '@/components/create-user-form';
import {
  impersonateUserAction,
  updateUserStatusAction,
} from '@/lib/user-actions';
import { useLocale, useTranslator } from '@/i18n/provider';
import { formatDate } from '@/i18n/core';

type StatusFilter = 'all' | 'ACTIVE' | 'DISABLED';

const PAGE_SIZES = [10, 20, 30, 50];

function initialsFromEmail(email: string): string {
  const local = email.split('@')[0] ?? email;
  const parts = local.split(/[._-]+/).filter(Boolean);
  const chars = parts.length > 1 ? [parts[0]![0], parts[1]![0]] : [local[0] ?? '?'];
  return chars.join('').toUpperCase();
}

function getPageNumbers(currentPage: number, pageCount: number): number[] {
  if (pageCount <= 3) return Array.from({ length: pageCount }, (_, i) => i + 1);
  if (currentPage <= 2) return [1, 2, 3];
  if (currentPage >= pageCount - 1) return [pageCount - 2, pageCount - 1, pageCount];
  return [currentPage - 1, currentPage, currentPage + 1];
}

function StatusBadge({ status }: { status: AdminUser['status'] }) {
  const t = useTranslator();
  const active = status === 'ACTIVE';
  return (
    <Badge
      variant="outline"
      className={
        active
          ? 'gap-1.5 border-emerald-500/20 bg-emerald-500/10 px-2 py-1 font-medium text-emerald-600 dark:text-emerald-400'
          : 'gap-1.5 border-border bg-muted/50 px-2 py-1 font-medium text-muted-foreground'
      }
    >
      <span
        className={
          active ? 'size-1.5 rounded-full bg-emerald-500' : 'size-1.5 rounded-full bg-muted-foreground'
        }
      />
      {active ? t('common.statusActive') : t('common.statusDisabled')}
    </Badge>
  );
}

export function UsersManager({
  users,
  total,
  page,
  pageSize,
  q,
  status,
  groupId,
  groups,
  error,
}: {
  users: AdminUser[];
  total: number;
  page: number;
  pageSize: number;
  q: string;
  status: StatusFilter;
  groupId: string;
  groups: PermissionGroupInfo[];
  error?: string | null;
}) {
  const t = useTranslator();
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const [search, setSearch] = useState(q);
  const firstRender = useRef(true);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageNumbers = getPageNumbers(currentPage, pageCount);

  function setParams(patch: Record<string, string | null>) {
    const params = new URLSearchParams();
    const merged: Record<string, string> = {
      ...(q ? { q } : {}),
      ...(status !== 'all' ? { status } : {}),
      ...(groupId ? { groupId } : {}),
      ...(pageSize !== 20 ? { pageSize: String(pageSize) } : {}),
      ...(page > 1 ? { page: String(page) } : {}),
      ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v ?? ''])),
    };
    for (const [key, value] of Object.entries(merged)) {
      if (value) params.set(key, value);
    }
    const qs = params.toString();
    startTransition(() => {
      router.push(qs ? `${pathname}?${qs}` : pathname);
    });
  }

  // Debounced search: sync the local input to the URL.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const handle = setTimeout(() => {
      setParams({ q: search.trim() || null, page: null });
    }, 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  function toggleStatus(user: AdminUser) {
    const next = user.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    startTransition(async () => {
      await updateUserStatusAction(user.id, next);
      router.refresh();
    });
  }

  function impersonate(user: AdminUser) {
    startTransition(async () => {
      await impersonateUserAction(user.id);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('admin.users.title')}
        description={t('admin.users.description')}
        actions={<CreateUserForm groups={groups} />}
      />

      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border/70 bg-background">
          <div className="flex flex-col items-stretch gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <InputGroup className="h-7 w-full rounded-md sm:w-80">
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              <InputGroupInput
                className="h-7"
                placeholder={t('admin.users.searchPlaceholder')}
                aria-label={t('admin.users.searchAria')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </InputGroup>

            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={status}
                onValueChange={(value) => setParams({ status: value === 'all' ? null : value, page: null })}
              >
                <SelectTrigger size="sm">
                  <span className="text-muted-foreground">{t('admin.users.colStatus')}</span>
                  <SelectValue>
                    {(value) =>
                      value === 'ACTIVE'
                        ? t('common.statusActive')
                        : value === 'DISABLED'
                          ? t('common.statusDisabled')
                          : t('admin.users.statusAll')
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent align="start" alignItemWithTrigger={false}>
                  <SelectGroup>
                    <SelectItem value="all">{t('admin.users.statusAll')}</SelectItem>
                    <SelectItem value="ACTIVE">{t('common.statusActive')}</SelectItem>
                    <SelectItem value="DISABLED">{t('common.statusDisabled')}</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>

              <Select
                value={groupId || 'all'}
                onValueChange={(value) => setParams({ groupId: value === 'all' ? null : value, page: null })}
              >
                <SelectTrigger size="sm">
                  <span className="text-muted-foreground">{t('admin.users.colGroups')}</span>
                  <SelectValue>
                    {(value) =>
                      value && value !== 'all'
                        ? (groups.find((group) => group.id === value)?.name ?? t('admin.users.groupAll'))
                        : t('admin.users.groupAll')
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent align="start" alignItemWithTrigger={false}>
                  <SelectGroup>
                    <SelectItem value="all">{t('admin.users.groupAll')}</SelectItem>
                    {groups.map((group) => (
                      <SelectItem key={group.id} value={group.id}>
                        {group.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          </div>

          <Table className="**:data-[slot=table-cell]:px-4 **:data-[slot=table-head]:px-4">
            <TableHeader className="[&_tr]:border-t">
              <TableRow className="hover:bg-transparent">
                <TableHead className="py-4 font-normal">{t('admin.users.colUser')}</TableHead>
                <TableHead className="py-4 font-normal">{t('admin.users.colGroups')}</TableHead>
                <TableHead className="py-4 font-normal">{t('admin.users.colStatus')}</TableHead>
                <TableHead className="py-4 font-normal">{t('admin.users.colJoined')}</TableHead>
                <TableHead className="py-4 font-normal">{t('admin.users.colLastLogin')}</TableHead>
                <TableHead className="py-4 text-right font-normal">{t('common.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                    {q ? t('admin.users.emptyQuery', { q }) : t('admin.users.empty')}
                  </TableCell>
                </TableRow>
              ) : (
                users.map((user) => (
                  <TableRow key={user.id} className="border-border/60">
                    <TableCell className="py-4">
                      <div className="flex items-center gap-3">
                        <Avatar>
                          <AvatarFallback className="font-medium">
                            {initialsFromEmail(user.email)}
                          </AvatarFallback>
                        </Avatar>
                        <Link
                          href={`/admin/users/${user.id}`}
                          className="truncate text-sm font-medium text-foreground hover:text-primary hover:underline"
                        >
                          {user.email}
                        </Link>
                      </div>
                    </TableCell>
                    <TableCell className="py-4">
                      {user.groups.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {user.groups.map((group) => (
                            <Badge key={group.id} variant="secondary" className="rounded-sm font-normal">
                              {group.name}
                            </Badge>
                          ))}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="py-4">
                      <StatusBadge status={user.status} />
                    </TableCell>
                    <TableCell className="py-4 text-sm text-muted-foreground">
                      {formatDate(new Date(user.createdAt), locale, { dateStyle: 'medium' })}
                    </TableCell>
                    <TableCell className="py-4 text-sm text-muted-foreground">
                      {user.lastLoginAt
                        ? formatDate(new Date(user.lastLoginAt), locale, {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })
                        : '—'}
                    </TableCell>
                    <TableCell className="py-4 text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="rounded-md text-muted-foreground"
                              aria-label={t('admin.users.actionsLabel')}
                            />
                          }
                        >
                          <MoreHorizontal className="size-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuItem render={<Link href={`/admin/users/${user.id}`} />}>
                            {t('admin.users.viewDetail')}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => toggleStatus(user)}
                            disabled={isPending}
                          >
                            {user.status === 'ACTIVE'
                              ? t('admin.users.disableUser')
                              : t('admin.users.enableUser')}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => impersonate(user)} disabled={isPending}>
                            {t('admin.users.impersonate')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>

          <div className="flex flex-col items-start gap-4 border-t border-border/70 p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-4 text-muted-foreground">
              <div className="flex items-center gap-2">
                <span>{t('admin.users.rowsPerPage')}</span>
                <Select
                  value={String(pageSize)}
                  onValueChange={(value) =>
                    setParams({
                      pageSize: value === '20' ? null : value,
                      page: null,
                    })
                  }
                >
                  <SelectTrigger size="sm" className="w-16">
                    <SelectValue>{(value) => value}</SelectValue>
                  </SelectTrigger>
                  <SelectContent side="top" alignItemWithTrigger={false}>
                    <SelectGroup>
                      {PAGE_SIZES.map((size) => (
                        <SelectItem key={size} value={String(size)}>
                          {size}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
              <span className="tabular-nums">
                {t('admin.users.pageInfo', { page: currentPage, pages: pageCount })}
              </span>
            </div>

            <Pagination className="mx-0 w-auto justify-start sm:justify-end">
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious
                    text=""
                    disabled={currentPage <= 1 || isPending}
                    onClick={() => setParams({ page: currentPage - 1 > 1 ? String(currentPage - 1) : null })}
                  />
                </PaginationItem>
                {pageNumbers[0]! > 1 ? (
                  <PaginationItem>
                    <PaginationEllipsis />
                  </PaginationItem>
                ) : null}
                {pageNumbers.map((pageNumber) => (
                  <PaginationItem key={pageNumber}>
                    <PaginationLink
                      isActive={pageNumber === currentPage}
                      disabled={isPending}
                      onClick={() =>
                        setParams({ page: pageNumber > 1 ? String(pageNumber) : null })
                      }
                    >
                      {pageNumber}
                    </PaginationLink>
                  </PaginationItem>
                ))}
                {pageNumbers[pageNumbers.length - 1]! < pageCount ? (
                  <PaginationItem>
                    <PaginationEllipsis />
                  </PaginationItem>
                ) : null}
                <PaginationItem>
                  <PaginationNext
                    text=""
                    disabled={currentPage >= pageCount || isPending}
                    onClick={() => setParams({ page: String(currentPage + 1) })}
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          </div>
        </div>
      )}
    </div>
  );
}
