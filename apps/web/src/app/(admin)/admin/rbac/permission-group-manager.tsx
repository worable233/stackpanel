'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { PermissionGroupView, PermissionInfo } from '@stackpanel/sdk';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  createPermissionGroupAction,
  deletePermissionGroupAction,
  updatePermissionGroupAction,
  type RbacActionResult,
} from '@/lib/rbac-actions';
import { useTranslator } from '@/i18n/provider';
import type { Translator } from '@/i18n/core';

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
      <DialogTrigger render={<Button variant="outline" className="w-fit" />}>
        {t('admin.rbac.createTrigger')}
      </DialogTrigger>
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
        <label
          key={permission.key}
          className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-sm hover:bg-muted/50"
        >
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
      ))}
    </div>
  );
}

function discountLabel(discount: number | null, t: Translator): string {
  return discount != null
    ? t('admin.rbac.discountPercent', {
        discount: ((100 - discount) / 10).toFixed(1).replace(/\.0$/, ''),
      })
    : t('admin.rbac.discountNone');
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

function DeleteGroupDialog({ group }: { group: PermissionGroupView }) {
  const router = useRouter();
  const t = useTranslator();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [state, setState] = useState<RbacActionResult | null>(null);

  function confirm() {
    setState(null);
    startTransition(async () => {
      const result = await deletePermissionGroupAction(group.id);
      setState(result);
      if (result.ok) {
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
      <DialogTrigger render={<Button variant="destructive" size="sm" />}>
        {t('admin.rbac.deleteTrigger')}
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('admin.rbac.deleteTitle')}</DialogTitle>
          <DialogDescription>
            {t('admin.rbac.deleteDescription', { name: group.name })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
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

function GroupCard({
  group,
  onEdit,
}: {
  group: PermissionGroupView;
  onEdit: () => void;
}) {
  const t = useTranslator();
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border bg-card p-4 text-card-foreground shadow-sm">
      <div className="min-w-0">
        <h3 className="text-base font-semibold">{group.name}</h3>
        {group.description ? (
          <p className="mt-0.5 text-sm text-muted-foreground">{group.description}</p>
        ) : null}
        <p className="mt-1 text-xs text-muted-foreground">
          {discountLabel(group.discount, t)} ·{' '}
          {t('admin.rbac.permissionCount', { count: group.permissions.length })}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onEdit}>
          {t('common.edit')}
        </Button>
        <DeleteGroupDialog group={group} />
      </div>
    </div>
  );
}

export function PermissionGroupManager({
  groups,
  permissions,
}: {
  groups: PermissionGroupView[];
  permissions: PermissionInfo[];
}) {
  const t = useTranslator();
  const [editing, setEditing] = useState<PermissionGroupView | null>(null);

  return (
    <div className="flex flex-col gap-6">
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('admin.rbac.empty')}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map((group) => (
            <GroupCard key={group.id} group={group} onEdit={() => setEditing(group)} />
          ))}
        </div>
      )}
      <EditGroupDialog
        key={editing?.id ?? 'closed'}
        group={editing}
        permissions={permissions}
        onClose={() => setEditing(null)}
      />
    </div>
  );
}
