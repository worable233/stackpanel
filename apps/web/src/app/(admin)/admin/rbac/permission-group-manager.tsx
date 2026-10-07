'use client';

import { Fragment, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CircleHelp, ChevronLeft, ChevronRight, MoreVertical, Search } from 'lucide-react';
import type { PermissionGroupView, PermissionInfo } from '@stackpanel/sdk';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@stackpanel/ui';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  createPermissionGroupAction,
  deletePermissionGroupAction,
  updatePermissionGroupAction,
  type RbacActionResult,
} from '@/lib/rbac-actions';
import { useLocale, useTranslator } from '@/i18n/provider';
import { formatNumber, type Translator } from '@/i18n/core';

const PAGE_SIZE = 12;

type TypeFilter = 'all' | 'system' | 'custom';

function StatusMessage({ state }: { state: RbacActionResult | null }) {
  if (!state) return null;
  if (state.ok && state.message) {
    return <span className="text-sm text-muted-foreground">{state.message}</span>;
  }
  if (state.error) {
    return <span className="text-sm text-destructive">{state.error}</span>;
  }
  return null;
}

export function CreateGroupForm() {
  const router = useRouter();
  const t = useTranslator();
  const [isPending, startTransition] = useTransition();
  const [state, setState] = useState<RbacActionResult | null>(null);
  const [discount, setDiscount] = useState('');
  const [open, setOpen] = useState(false);

  function submit(formData: FormData) {
    const name = formData.get('name');
    const description = formData.get('description');
    if (typeof name !== 'string' || !name.trim()) {
      setState({ error: t('admin.rbac.nameRequired') });
      return;
    }
    let parsedDiscount: number | null = null;
    if (discount.trim() !== '') {
      const value = Number(discount);
      if (!Number.isInteger(value) || value < 0 || value > 99) {
        setState({ error: t('admin.rbac.discountInvalid') });
        return;
      }
      parsedDiscount = value;
    }
    setState(null);
    startTransition(async () => {
      const result = await createPermissionGroupAction({
        name,
        ...(typeof description === 'string' && description.trim() ? { description } : {}),
        discount: parsedDiscount,
      });
      setState(result);
      if (result.ok) {
        setDiscount('');
        router.refresh();
        setOpen(false);
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setState(null);
      }}
    >
      <DialogTrigger render={<Button size="sm" />}>{t('admin.rbac.createTrigger')}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('admin.rbac.createTitle')}</DialogTitle>
          <DialogDescription>{t('admin.rbac.createDescription')}</DialogDescription>
        </DialogHeader>
        <form action={submit} className="mt-4 flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="group-name">{t('admin.rbac.name')}</Label>
            <Input
              id="group-name"
              name="name"
              maxLength={64}
              required
              placeholder={t('admin.rbac.namePlaceholder')}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="group-description">{t('admin.rbac.description')}</Label>
            <Input
              id="group-description"
              name="description"
              maxLength={191}
              placeholder={t('admin.rbac.optional')}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="group-discount">{t('admin.rbac.discount')}</Label>
            <Input
              id="group-discount"
              type="number"
              min={0}
              max={99}
              value={discount}
              onChange={(e) => setDiscount(e.target.value)}
              placeholder={t('admin.rbac.discountPlaceholder')}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={isPending}>
              {isPending ? t('admin.rbac.creating') : t('admin.rbac.createSubmit')}
            </Button>
            <StatusMessage state={state} />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PermissionCheckboxes({
  permissions,
  selected,
  onToggle,
  disabled,
}: {
  permissions: PermissionInfo[];
  selected: string[];
  onToggle: (key: string) => void;
  disabled: boolean;
}) {
  const t = useTranslator();
  if (permissions.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('admin.rbac.noPermissions')}</p>;
  }
  return (
    <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
      {permissions.map((permission) => (
        <div
          key={permission.key}
          className="flex items-center gap-2 rounded-md px-1 py-0.5 text-sm hover:bg-muted/50"
        >
          <label className="flex flex-1 cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={selected.includes(permission.key)}
              onChange={() => onToggle(permission.key)}
              disabled={disabled}
              className="size-4 rounded border-input accent-primary"
            />
            <span className="font-mono text-xs text-muted-foreground">{permission.key}</span>
            <span>{permission.name}</span>
          </label>
          <Tooltip>
            <TooltipTrigger
              type="button"
              aria-label={t('admin.rbac.permissionHelpLabel')}
              className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <CircleHelp className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>
              {permission.description ?? t('admin.rbac.permissionNoDescription')}
            </TooltipContent>
          </Tooltip>
        </div>
      ))}
    </div>
  );
}

function discountLabel(discount: number | null, t: Translator): string {
  if (discount == null) return t('admin.rbac.discountNone');
  const fold = ((100 - discount) / 10).toFixed(1).replace(/\.0$/, '');
  return t('admin.rbac.discountPercent', { discount, fold });
}

function EditGroupDialog({
  group,
  permissions,
  onClose,
}: {
  group: PermissionGroupView | null;
  permissions: PermissionInfo[];
  onClose: () => void;
}) {
  const router = useRouter();
  const t = useTranslator();
  const [isPending, startTransition] = useTransition();
  const [state, setState] = useState<RbacActionResult | null>(null);
  // 弹窗仅在 open（group 非空）时渲染，父级以 group.id 作 key 强制重挂载，
  // 表单初值直接取自 props，避免用 effect 同步 props 到 state。
  const [name, setName] = useState(group?.name ?? '');
  const [description, setDescription] = useState(group?.description ?? '');
  const [discount, setDiscount] = useState(
    group?.discount == null ? '' : String(group.discount),
  );
  const [selected, setSelected] = useState<string[]>(
    () => group?.permissions.map((permission) => permission.key) ?? [],
  );

  function toggle(key: string) {
    setSelected((prev) =>
      prev.includes(key) ? prev.filter((existing) => existing !== key) : [...prev, key],
    );
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!group) return;
    if (!name.trim()) {
      setState({ error: t('admin.rbac.nameRequired') });
      return;
    }
    let parsedDiscount: number | null = null;
    if (discount.trim() !== '') {
      const value = Number(discount);
      if (!Number.isInteger(value) || value < 0 || value > 99) {
        setState({ error: t('admin.rbac.discountInvalid') });
        return;
      }
      parsedDiscount = value;
    }
    setState(null);
    startTransition(async () => {
      const result = await updatePermissionGroupAction(group.id, {
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : { description: '' }),
        permissionKeys: selected,
        discount: parsedDiscount,
      });
      setState(result);
      if (result.ok) {
        router.refresh();
        onClose();
      }
    });
  }

  return (
    <Dialog
      open={group !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('admin.rbac.editTitle')}</DialogTitle>
          <DialogDescription>{t('admin.rbac.editDescription')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="mt-4 flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="edit-group-name">{t('admin.rbac.name')}</Label>
            <Input
              id="edit-group-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={64}
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="edit-group-description">{t('admin.rbac.description')}</Label>
            <Input
              id="edit-group-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={191}
              placeholder={t('admin.rbac.optional')}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="edit-group-discount">{t('admin.rbac.discount')}</Label>
            <Input
              id="edit-group-discount"
              type="number"
              min={0}
              max={99}
              value={discount}
              onChange={(e) => setDiscount(e.target.value)}
              placeholder={t('admin.rbac.discountPlaceholder')}
            />
            <p className="text-xs text-muted-foreground">
              {t('admin.rbac.discountCurrent', {
                label:
                  discount.trim() === '' || Number.isNaN(Number(discount))
                    ? t('admin.rbac.discountNone')
                    : discountLabel(Number(discount), t),
              })}
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Label>{t('admin.rbac.permissions')}</Label>
            <PermissionCheckboxes
              permissions={permissions}
              selected={selected}
              onToggle={toggle}
              disabled={isPending}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={isPending}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? t('admin.rbac.saving') : t('common.save')}
            </Button>
          </DialogFooter>
          <StatusMessage state={state} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteGroupDialog({
  group,
  open,
  onOpenChange,
}: {
  group: PermissionGroupView | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const t = useTranslator();
  const [isPending, startTransition] = useTransition();
  const [state, setState] = useState<RbacActionResult | null>(null);

  function confirm() {
    if (!group) return;
    setState(null);
    startTransition(async () => {
      const result = await deletePermissionGroupAction(group.id);
      setState(result);
      if (result.ok) {
        router.refresh();
        onOpenChange(false);
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setState(null);
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('admin.rbac.deleteTitle')}</DialogTitle>
          <DialogDescription>
            {t('admin.rbac.deleteDescription', { name: group?.name ?? '' })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => void confirm()}
            disabled={isPending}
          >
            {isPending ? t('admin.rbac.deleting') : t('admin.rbac.deleteConfirm')}
          </Button>
        </DialogFooter>
        <StatusMessage state={state} />
      </DialogContent>
    </Dialog>
  );
}

function PermissionGroupsTable({
  groups,
  totals,
  onEdit,
  onDelete,
}: {
  groups: PermissionGroupView[];
  totals: { system: number; custom: number };
  onEdit: (group: PermissionGroupView) => void;
  onDelete: (group: PermissionGroupView) => void;
}) {
  const t = useTranslator();
  const locale = useLocale();
  const sections = [
    { key: 'system', label: t('admin.rbac.typeSystem'), count: totals.system, rows: groups.filter((g) => g.structural) },
    { key: 'custom', label: t('admin.rbac.typeCustom'), count: totals.custom, rows: groups.filter((g) => !g.structural) },
  ].filter((section) => section.rows.length > 0);

  return (
    <div className="overflow-hidden border-t border-border/70 bg-background">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="h-10 px-4">{t('admin.rbac.colGroup')}</TableHead>
            <TableHead className="px-4 text-center">{t('admin.rbac.colType')}</TableHead>
            <TableHead className="px-4 text-center">{t('admin.rbac.colMembers')}</TableHead>
            <TableHead className="px-4">{t('admin.rbac.colPermissions')}</TableHead>
            <TableHead className="px-4 text-right">{t('admin.rbac.colDiscount')}</TableHead>
            <TableHead className="w-10 px-2" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {sections.length ? (
            sections.map((section) => (
              <Fragment key={section.key}>
                <TableRow className="h-10 bg-muted hover:bg-muted">
                  <TableCell colSpan={6} className="px-4 text-sm text-foreground/60">
                    <span className="inline-flex items-center gap-2">
                      {section.label}
                      <Badge variant="outline" className="rounded-sm bg-transparent text-xs text-muted-foreground">
                        {section.count}
                      </Badge>
                    </span>
                  </TableCell>
                </TableRow>
                {section.rows.map((group) => (
                  <TableRow key={group.id} className="h-12">
                    <TableCell className="px-4">
                      <div className="font-medium">{group.name}</div>
                      {group.description ? (
                        <div className="text-xs text-muted-foreground">{group.description}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="px-4 text-center">
                      <Badge variant="outline" className="rounded-sm">
                        {group.structural ? t('admin.rbac.typeSystem') : t('admin.rbac.typeCustom')}
                      </Badge>
                    </TableCell>
                    <TableCell className="px-4 text-center tabular-nums">
                      {formatNumber(group.memberCount, locale)}
                    </TableCell>
                    <TableCell className="px-4">
                      <div className="flex flex-wrap items-center gap-2">
                        {group.permissions.slice(0, 3).map((permission) => (
                          <Badge
                            key={permission.key}
                            variant="outline"
                            className="rounded-sm font-normal"
                          >
                            {permission.name}
                          </Badge>
                        ))}
                        {group.permissions.length > 3 ? (
                          <span className="text-sm tabular-nums text-muted-foreground">
                            +{group.permissions.length - 3}
                          </span>
                        ) : null}
                        {group.permissions.length === 0 ? (
                          <span className="text-sm text-muted-foreground">
                            {t('admin.rbac.permissionNone')}
                          </span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="px-4 text-right tabular-nums">
                      {discountLabel(group.discount, t)}
                    </TableCell>
                    <TableCell className="px-2 text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={t('common.actions')}
                            >
                              <MoreVertical className="size-4" />
                            </Button>
                          }
                        />
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuItem onClick={() => onEdit(group)}>
                            {t('common.edit')}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            disabled={group.structural}
                            onClick={() => onDelete(group)}
                          >
                            {t('common.delete')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </Fragment>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                {t('admin.rbac.empty')}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function groupPermissionsByNamespace(permissions: PermissionInfo[]) {
  const map = new Map<string, PermissionInfo[]>();
  for (const permission of permissions) {
    const namespace = permission.key.split('.')[0] ?? permission.key;
    const bucket = map.get(namespace);
    if (bucket) bucket.push(permission);
    else map.set(namespace, [permission]);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([namespace, items]) => ({ namespace, items }));
}

function PermissionList({ permissions }: { permissions: PermissionInfo[] }) {
  const t = useTranslator();
  const groups = useMemo(() => groupPermissionsByNamespace(permissions), [permissions]);

  if (groups.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('admin.rbac.permissionNone')}</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {groups.map((group) => (
        <div
          key={group.namespace}
          className="rounded-xl border border-border/70 bg-background p-4"
        >
          <div className="mb-3 flex items-center gap-2">
            <span className="font-mono text-sm font-medium">{group.namespace}</span>
            <Badge variant="outline" className="rounded-sm text-muted-foreground">
              {group.items.length}
            </Badge>
          </div>
          <div className="flex flex-wrap gap-2">
            {group.items.map((permission) => (
              <Badge
                key={permission.id}
                variant="outline"
                className="rounded-sm font-normal"
                title={permission.key}
              >
                {permission.name}
              </Badge>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function PermissionGroupManager({
  groups,
  permissions,
  error,
}: {
  groups: PermissionGroupView[];
  permissions: PermissionInfo[];
  error?: string | null;
}) {
  const t = useTranslator();
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<PermissionGroupView | null>(null);
  const [deleting, setDeleting] = useState<PermissionGroupView | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return groups.filter((group) => {
      if (typeFilter === 'system' && !group.structural) return false;
      if (typeFilter === 'custom' && group.structural) return false;
      if (!q) return true;
      if (group.name.toLowerCase().includes(q)) return true;
      if (group.description?.toLowerCase().includes(q)) return true;
      return group.permissions.some(
        (permission) =>
          permission.name.toLowerCase().includes(q) || permission.key.toLowerCase().includes(q),
      );
    });
  }, [groups, search, typeFilter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const startIndex = (currentPage - 1) * PAGE_SIZE;
  const pageGroups = filtered.slice(startIndex, startIndex + PAGE_SIZE);
  const start = filtered.length === 0 ? 0 : startIndex + 1;
  const end = Math.min(startIndex + PAGE_SIZE, filtered.length);
  const paged = filtered.length > PAGE_SIZE;
  const totals = useMemo(
    () => ({
      system: filtered.filter((group) => group.structural).length,
      custom: filtered.filter((group) => !group.structural).length,
    }),
    [filtered],
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('admin.rbac.title')}
        description={t('admin.rbac.pageDescription')}
        actions={<CreateGroupForm />}
      />

      {error ? (
        <p className="text-sm text-destructive">
          {t('admin.rbac.serviceUnavailable', { error })}
        </p>
      ) : (
        <Tabs className="gap-4" defaultValue="roles">
          <TabsList
            variant="line"
            className="w-full justify-start gap-2 border-b ps-0 *:data-[slot=tabs-trigger]:flex-none"
          >
            <TabsTrigger value="roles">{t('admin.rbac.tabRoles')}</TabsTrigger>
            <TabsTrigger value="permission-sets">{t('admin.rbac.tabPermissionSets')}</TabsTrigger>
          </TabsList>

          <TabsContent value="roles">
            <div className="overflow-hidden rounded-xl border border-border/70 bg-background">
              <div className="flex flex-col items-stretch gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
                <InputGroup className="h-7 w-full rounded-md sm:w-80">
                  <InputGroupAddon>
                    <Search />
                  </InputGroupAddon>
                  <InputGroupInput
                    className="h-7"
                    placeholder={t('admin.rbac.searchPlaceholder')}
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setPage(1);
                    }}
                  />
                </InputGroup>

                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    value={typeFilter}
                    onValueChange={(value) => {
                      setTypeFilter(value as TypeFilter);
                      setPage(1);
                    }}
                  >
                    <SelectTrigger size="sm">
                      <span className="text-muted-foreground">{t('admin.rbac.typeLabel')}</span>
                      <SelectValue>
                        {(value) =>
                          value === 'system'
                            ? t('admin.rbac.typeSystem')
                            : value === 'custom'
                              ? t('admin.rbac.typeCustom')
                              : t('admin.rbac.typeAll')
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent align="start" alignItemWithTrigger={false}>
                      <SelectGroup>
                        <SelectItem value="all">{t('admin.rbac.typeAll')}</SelectItem>
                        <SelectItem value="system">{t('admin.rbac.typeSystem')}</SelectItem>
                        <SelectItem value="custom">{t('admin.rbac.typeCustom')}</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <PermissionGroupsTable
                groups={pageGroups}
                totals={totals}
                onEdit={setEditing}
                onDelete={setDeleting}
              />

              {paged ? (
                <div className="flex items-center justify-between border-t border-border/70 p-4 text-sm">
                  <div className="text-muted-foreground">
                    {t('admin.rbac.showing', { start, end, total: filtered.length })}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="icon-sm"
                      disabled={currentPage <= 1}
                      aria-label={t('common.prevPage')}
                      onClick={() => setPage(currentPage - 1)}
                    >
                      <ChevronLeft />
                    </Button>
                    <span className="tabular-nums">
                      {currentPage} / {pageCount}
                    </span>
                    <Button
                      variant="outline"
                      size="icon-sm"
                      disabled={currentPage >= pageCount}
                      aria-label={t('common.nextPage')}
                      onClick={() => setPage(currentPage + 1)}
                    >
                      <ChevronRight />
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          </TabsContent>

          <TabsContent value="permission-sets">
            <PermissionList permissions={permissions} />
          </TabsContent>
        </Tabs>
      )}

      <EditGroupDialog
        key={editing?.id ?? 'closed'}
        group={editing}
        permissions={permissions}
        onClose={() => setEditing(null)}
      />
      <DeleteGroupDialog
        group={deleting}
        open={deleting !== null}
        onOpenChange={(next) => {
          if (!next) setDeleting(null);
        }}
      />
    </div>
  );
}
