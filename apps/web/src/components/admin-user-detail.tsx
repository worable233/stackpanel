'use client';

import { useState, useTransition } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { SectionTitle } from '@stackpanel/ui';
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuCheckboxItem,
} from '@/components/ui/dropdown-menu';
import type {
  AdminUpstreamServiceItem,
  AdminUserDetailResponse,
  PermissionGroupView,
} from '@stackpanel/sdk';
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  adjustUserWalletAction,
  bindUpstreamServiceAction,
  deleteServiceAction,
  listUpstreamServicesAction,
  unbindUpstreamServiceAction,
  updateServiceAction,
  updateUserGroupsAction,
  updateUserStatusAction,
  type UserActionResult,
} from '@/lib/user-actions';
import { useTranslator, useLocale } from '@/i18n/provider';
import type { Translator } from '@/i18n/core';
import { formatMoney, formatDate as formatLocaleDate } from '@/i18n/core';
import type { Locale } from '@/i18n/config';

const SERVICE_STATUS_KEYS: Record<string, string> = {
  PENDING_PROVISION: 'admin.userDetail.serviceStatus.PENDING_PROVISION',
  PROVISIONING: 'admin.userDetail.serviceStatus.PROVISIONING',
  ACTIVE: 'admin.userDetail.serviceStatus.ACTIVE',
  SUSPENDED: 'admin.userDetail.serviceStatus.SUSPENDED',
  TERMINATED: 'admin.userDetail.serviceStatus.TERMINATED',
  FAILED: 'admin.userDetail.serviceStatus.FAILED',
};

function serviceStatusLabel(status: string, t: Translator): string {
  const key = SERVICE_STATUS_KEYS[status];
  return key ? t(key) : status;
}

function money(amount: number, currency: string, locale: Locale): string {
  return formatMoney(amount, currency, locale);
}

function formatDate(iso: string | null | undefined, locale: Locale): string {
  if (!iso) return '—';
  // Both server render and client hydration use the negotiated locale, so the
  // markup stays identical (ADR-0016 §6).
  return formatLocaleDate(new Date(iso), locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function StatusMessage({ state }: { state: UserActionResult | null }) {
  if (!state) return null;
  if (state.ok && state.message) {
    return <span className="text-sm text-muted-foreground">{state.message}</span>;
  }
  if (state.error) {
    return <span className="text-sm text-destructive">{state.error}</span>;
  }
  return null;
}

function SectionCard({
  title,
  description,
  children,
  action,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border bg-card p-5 text-card-foreground shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <SectionTitle>{title}</SectionTitle>
          {description ? (
            <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function BasicInfoSection({ user }: { user: AdminUserDetailResponse['user'] }) {
  const router = useRouter();
  const t = useTranslator();
  const locale = useLocale();
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState(user.status);
  const [state, setState] = useState<UserActionResult | null>(null);

  function save() {
    if (status === user.status) return;
    setState(null);
    startTransition(async () => {
      const result = await updateUserStatusAction(user.id, status);
      setState(result);
      if (result.ok) router.refresh();
    });
  }

  return (
    <SectionCard
      title={t('admin.userDetail.basic.title')}
      description={t('admin.userDetail.basic.description')}
    >
      <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
        <div>
          <dt className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            {t('admin.userDetail.email')}
          </dt>
          <dd className="mt-0.5 text-sm">{user.email}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            {t('admin.userDetail.status')}
          </dt>
          <dd className="mt-0.5 flex items-center gap-2">
            <Select
              value={status}
              onValueChange={(value) => {
                if (value) setStatus(value);
              }}
              disabled={isPending}
            >
              <SelectTrigger className="w-32" aria-label={t('admin.userDetail.statusAria')}>
                <SelectValue>
                  {status === 'ACTIVE'
                    ? t('admin.userDetail.statusActive')
                    : t('admin.userDetail.statusDisabled')}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="ACTIVE">{t('admin.userDetail.statusActive')}</SelectItem>
                  <SelectItem value="DISABLED">{t('admin.userDetail.statusDisabled')}</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            {status !== user.status ? (
              <Button size="sm" variant="outline" onClick={() => void save()} disabled={isPending}>
                {t('common.save')}
              </Button>
            ) : null}
            <StatusMessage state={state} />
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            {t('admin.userDetail.createdAt')}
          </dt>
          <dd className="mt-0.5 text-sm">{formatDate(user.createdAt, locale)}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            {t('admin.userDetail.lastLoginAt')}
          </dt>
          <dd className="mt-0.5 text-sm">{formatDate(user.lastLoginAt, locale)}</dd>
        </div>
      </dl>
    </SectionCard>
  );
}

function GroupsSection({
  userId,
  currentGroupIds,
  groups,
}: {
  userId: string;
  currentGroupIds: string[];
  groups: PermissionGroupView[];
}) {
  const router = useRouter();
  const t = useTranslator();
  const [isPending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set(currentGroupIds));
  const [state, setState] = useState<UserActionResult | null>(null);
  const dirty = !(
    selected.size === currentGroupIds.length && currentGroupIds.every((id) => selected.has(id))
  );

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function save() {
    setState(null);
    startTransition(async () => {
      const result = await updateUserGroupsAction(userId, [...selected]);
      setState(result);
      if (result.ok) router.refresh();
    });
  }

  return (
    <SectionCard
      title={t('admin.userDetail.groups.title')}
      description={t('admin.userDetail.groups.description')}
      action={
        dirty ? (
          <Button size="sm" onClick={() => void save()} disabled={isPending || selected.size === 0}>
            {t('common.save')}
          </Button>
        ) : null
      }
    >
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="outline" disabled={isPending} className="max-w-full" />}
        >
          <span className="truncate">
            {groups
              .filter((group) => selected.has(group.id))
              .map((group) => group.name)
              .join('、') || t('admin.userDetail.groups.title')}
          </span>
          <ChevronDown data-icon="inline-end" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-52">
          <DropdownMenuGroup>
            {groups.map((group) => (
              <DropdownMenuCheckboxItem
                key={group.id}
                checked={selected.has(group.id)}
                onCheckedChange={() => toggle(group.id)}
                closeOnClick={false}
              >
                {group.name}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="mt-2">
        <StatusMessage state={state} />
      </div>
    </SectionCard>
  );
}

function WalletSection({
  userId,
  wallet,
  ledger,
}: {
  userId: string;
  wallet: AdminUserDetailResponse['wallet'];
  ledger: AdminUserDetailResponse['ledger'];
}) {
  const router = useRouter();
  const t = useTranslator();
  const locale = useLocale();
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [state, setState] = useState<UserActionResult | null>(null);

  function submit() {
    setState(null);
    startTransition(async () => {
      const result = await adjustUserWalletAction(userId, Number(amount) * 100, note);
      setState(result);
      if (result.ok) {
        setOpen(false);
        setAmount('');
        setNote('');
        router.refresh();
      }
    });
  }

  return (
    <SectionCard
      title={t('admin.userDetail.wallet.title')}
      description={t('admin.userDetail.wallet.description')}
      action={
        <Dialog
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) {
              setState(null);
              setAmount('');
              setNote('');
            }
          }}
        >
          <DialogTrigger render={<Button size="sm" variant="outline" />}>
            {t('admin.userDetail.wallet.adjust')}
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{t('admin.userDetail.wallet.adjust')}</DialogTitle>
              <DialogDescription>
                {t('admin.userDetail.wallet.current', {
                  amount: wallet
                    ? money(wallet.balance, wallet.currency, locale)
                    : money(0, 'CNY', locale),
                })}
              </DialogDescription>
            </DialogHeader>
            <div className="mt-4 flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <Label htmlFor="wallet-amount">{t('admin.userDetail.wallet.amount')}</Label>
                <Input
                  id="wallet-amount"
                  type="number"
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder={t('admin.userDetail.wallet.amountPlaceholder')}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="wallet-note">{t('admin.userDetail.wallet.note')}</Label>
                <Input
                  id="wallet-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={191}
                  placeholder={t('admin.userDetail.wallet.notePlaceholder')}
                />
              </div>
              {state?.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
              <DialogFooter>
                <Button onClick={() => void submit()} disabled={isPending}>
                  {isPending
                    ? t('admin.userDetail.wallet.submitting')
                    : t('admin.userDetail.wallet.submit')}
                </Button>
              </DialogFooter>
            </div>
          </DialogContent>
        </Dialog>
      }
    >
      <div className="text-2xl font-semibold">
        {wallet ? money(wallet.balance, wallet.currency, locale) : money(0, 'CNY', locale)}
      </div>

      {state?.ok ? <p className="mt-2 text-sm text-muted-foreground">{state.message}</p> : null}

      {ledger.length > 0 ? (
        <div className="mt-4 overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{t('admin.userDetail.ledger.time')}</th>
                <th className="px-3 py-2 font-medium">{t('admin.userDetail.ledger.change')}</th>
                <th className="px-3 py-2 font-medium">{t('admin.userDetail.ledger.type')}</th>
                <th className="px-3 py-2 font-medium">{t('admin.userDetail.ledger.note')}</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((entry) => (
                <tr key={entry.id} className="border-t">
                  <td className="px-3 py-2 text-muted-foreground">
                    {formatDate(entry.createdAt, locale)}
                  </td>
                  <td
                    className={
                      entry.amount > 0 ? 'px-3 py-2 text-success' : 'px-3 py-2 text-destructive'
                    }
                  >
                    {entry.amount > 0 ? '+' : ''}
                    {money(entry.amount, entry.currency, locale)}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{entry.type}</td>
                  <td className="px-3 py-2 text-muted-foreground">{entry.note ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </SectionCard>
  );
}

function ServicesSection({
  userId,
  services,
}: {
  userId: string;
  services: AdminUserDetailResponse['services'];
}) {
  const router = useRouter();
  const t = useTranslator();
  const locale = useLocale();
  const [isPending, startTransition] = useTransition();
  const [state, setState] = useState<UserActionResult | null>(null);

  const [bindOpen, setBindOpen] = useState(false);
  const [bindLoading, setBindLoading] = useState(false);
  const [bindError, setBindError] = useState<string | null>(null);
  const [hasSources, setHasSources] = useState(false);
  const [candidates, setCandidates] = useState<AdminUpstreamServiceItem[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [inventoryProduct, setInventoryProduct] = useState('all');
  const productKey = (item: AdminUpstreamServiceItem) =>
    JSON.stringify([item.sourceId, item.sourceRef ?? null, item.productId ?? item.productName]);
  const inventoryProducts = [
    ...new Map(candidates.map((item) => [productKey(item), item])).entries(),
  ];
  const visibleCandidates = candidates.filter(
    (item) => inventoryProduct === 'all' || productKey(item) === inventoryProduct,
  );

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editExpiresAt, setEditExpiresAt] = useState('');
  const [editStatus, setEditStatus] = useState('');
  /** 待确认的解绑/删除：原生 `window.confirm` 无法本地化按钮也不能被测试。 */
  const [confirmTarget, setConfirmTarget] = useState<{ id: string; bound: boolean } | null>(null);

  function run(action: () => Promise<UserActionResult>) {
    setState(null);
    startTransition(async () => {
      const result = await action();
      setState(result);
      if (result.ok) {
        setEditingId(null);
        setBindOpen(false);
        router.refresh();
      }
    });
  }

  function openBind(next: boolean) {
    setBindOpen(next);
    setState(null);
    if (!next) return;
    setBindError(null);
    setSelected('');
    setInventoryProduct('all');
    setCandidates([]);
    setBindLoading(true);
    void listUpstreamServicesAction(userId)
      .then((result) => {
        if (result.error || !result.data) {
          setBindError(result.error ?? t('admin.userDetail.services.bindLoadFailed'));
        } else {
          setHasSources(result.data.sources.length > 0);
          setCandidates(result.data.services);
          const first = result.data.services.find(
            (item) => !item.boundServiceId && !item.boundUserId,
          );
          if (first)
            setSelected(JSON.stringify([first.sourceId, first.sourceRef ?? null, first.id]));
        }
      })
      .catch(() => setBindError(t('admin.userDetail.services.bindLoadFailed')))
      .finally(() => setBindLoading(false));
  }

  function bind() {
    const item = candidates.find(
      (candidate) =>
        JSON.stringify([candidate.sourceId, candidate.sourceRef ?? null, candidate.id]) ===
        selected,
    );
    if (!item) {
      setState({ error: t('admin.userDetail.services.selectUpstream') });
      return;
    }
    run(() =>
      bindUpstreamServiceAction(userId, {
        sourceId: item.sourceId,
        providerServiceId: item.id,
        ...(item.sourceRef ? { sourceRef: item.sourceRef } : {}),
      }),
    );
  }

  function startEdit(service: AdminUserDetailResponse['services'][number]) {
    setEditingId(service.id);
    setEditExpiresAt(service.expiresAt ? service.expiresAt.slice(0, 10) : '');
    setEditStatus(service.status);
  }

  function saveEdit(serviceId: string) {
    run(() =>
      updateServiceAction(userId, serviceId, {
        ...(editExpiresAt ? { expiresAt: `${editExpiresAt}T00:00:00.000Z` } : { expiresAt: null }),
        ...(editStatus ? { status: editStatus } : {}),
      }),
    );
  }

  function remove(serviceId: string) {
    setConfirmTarget({ id: serviceId, bound: boundServiceIds(services).has(serviceId) });
  }

  function confirmRemove() {
    const target = confirmTarget;
    if (!target) return;
    setConfirmTarget(null);
    run(() =>
      target.bound
        ? unbindUpstreamServiceAction(userId, target.id)
        : deleteServiceAction(userId, target.id),
    );
  }

  return (
    <SectionCard
      title={t('admin.userDetail.services.title')}
      description={t('admin.userDetail.services.description')}
      action={
        <Dialog open={bindOpen} onOpenChange={openBind}>
          <DialogTrigger render={<Button size="sm" variant="outline" />}>
            {t('admin.userDetail.services.bind')}
          </DialogTrigger>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{t('admin.userDetail.services.bind')}</DialogTitle>
              <DialogDescription>
                {t('admin.userDetail.services.bindDescription')}
              </DialogDescription>
            </DialogHeader>
            <div className="mt-4 flex flex-col gap-4">
              {bindLoading ? (
                <p className="text-sm text-muted-foreground">
                  {t('admin.userDetail.services.bindLoading')}
                </p>
              ) : bindError ? (
                <div className="flex flex-col items-start gap-3">
                  <p role="alert" className="text-sm text-destructive">
                    {bindError}
                  </p>
                  <Button variant="outline" size="sm" onClick={() => openBind(true)}>
                    {t('common.retry')}
                  </Button>
                </div>
              ) : candidates.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {hasSources
                    ? t('admin.userDetail.services.upstreamEmpty')
                    : t('admin.userDetail.services.noUpstreamPlugin')}
                </p>
              ) : (
                <div className="flex flex-col gap-1">
                  <Label htmlFor="bind-product">
                    {t('admin.userDetail.services.upstreamProduct')}
                  </Label>
                  <Select
                    value={inventoryProduct}
                    onValueChange={(value) => {
                      setInventoryProduct(value ?? 'all');
                      setSelected('');
                    }}
                  >
                    <SelectTrigger id="bind-product" className="w-full">
                      <SelectValue>
                        {inventoryProduct === 'all'
                          ? t('admin.userDetail.services.allProducts')
                          : inventoryProducts.find(([key]) => key === inventoryProduct)?.[1]
                              .productName}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="all">
                          {t('admin.userDetail.services.allProducts')}
                        </SelectItem>
                        {inventoryProducts.map(([key, item]) => (
                          <SelectItem key={key} value={key}>
                            {item.productName ?? item.name}
                            {item.sourceRef ? ` · ${item.sourceRef}` : ''}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <Label htmlFor="bind-service">
                    {t('admin.userDetail.services.upstreamService')}
                  </Label>
                  <Select value={selected} onValueChange={(value) => setSelected(value ?? '')}>
                    <SelectTrigger id="bind-service" className="w-full">
                      <SelectValue>
                        {candidates.find(
                          (item) =>
                            JSON.stringify([item.sourceId, item.sourceRef ?? null, item.id]) ===
                            selected,
                        )?.name ?? t('admin.userDetail.services.selectUpstream')}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {visibleCandidates.map((item) => {
                          const boundMine = Boolean(item.boundServiceId);
                          const boundOther = Boolean(item.boundUserId);
                          const suffix = boundMine
                            ? ` · ${t('admin.userDetail.services.alreadyBound')}`
                            : boundOther
                              ? ` · ${t('admin.userDetail.services.boundElsewhere')}`
                              : '';
                          return (
                            <SelectItem
                              key={JSON.stringify([item.sourceId, item.sourceRef ?? null, item.id])}
                              value={JSON.stringify([
                                item.sourceId,
                                item.sourceRef ?? null,
                                item.id,
                              ])}
                              disabled={boundMine || boundOther}
                            >
                              {item.name}
                              {item.productName ? ` · ${item.productName}` : ''}
                              {` · #${item.id}`}
                              {item.sourceRef ? ` · ${item.sourceRef}` : ''}
                              {item.host ? ` · ${item.host}` : ''}
                              {suffix}
                            </SelectItem>
                          );
                        })}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
              )}
              <StatusMessage state={state} />
              <DialogFooter>
                <Button
                  onClick={() => void bind()}
                  disabled={isPending || bindLoading || !selected}
                >
                  {isPending
                    ? t('admin.userDetail.services.binding')
                    : t('admin.userDetail.services.bindSubmit')}
                </Button>
              </DialogFooter>
            </div>
          </DialogContent>
        </Dialog>
      }
    >
      {state?.ok ? <p className="mb-2 text-sm text-muted-foreground">{state.message}</p> : null}

      {services.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          {t('admin.userDetail.services.empty')}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">
                  {t('admin.userDetail.services.colProduct')}
                </th>
                <th className="px-3 py-2 font-medium">
                  {t('admin.userDetail.services.colStatus')}
                </th>
                <th className="px-3 py-2 font-medium">
                  {t('admin.userDetail.services.colAmount')}
                </th>
                <th className="px-3 py-2 font-medium">
                  {t('admin.userDetail.services.colExpiresAt')}
                </th>
                <th className="px-3 py-2 font-medium">
                  {t('admin.userDetail.services.colCreatedAt')}
                </th>
                <th className="px-3 py-2 font-medium">
                  {t('admin.userDetail.services.colActions')}
                </th>
              </tr>
            </thead>
            <tbody>
              {services.map((service) => {
                const editing = editingId === service.id;
                const bound = Boolean(service.providerId && service.providerServiceId);
                return (
                  <tr key={service.id} className="border-t align-top">
                    <td className="px-3 py-2">
                      <div className="font-medium">{service.productName}</div>
                      <div className="text-xs text-muted-foreground">
                        {bound
                          ? t('admin.userDetail.services.sourceUpstream')
                          : service.fulfillmentType}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {editing ? (
                        <Select
                          value={editStatus}
                          onValueChange={(value) => setEditStatus(value ?? '')}
                        >
                          <SelectTrigger aria-label={t('admin.userDetail.services.statusAria')}>
                            <SelectValue>{serviceStatusLabel(editStatus, t)}</SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {Object.keys(SERVICE_STATUS_KEYS).map((value) => (
                                <SelectItem key={value} value={value}>
                                  {serviceStatusLabel(value, t)}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      ) : (
                        serviceStatusLabel(service.status, t)
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {money(service.amount, service.currency, locale)}
                    </td>
                    <td className="px-3 py-2">
                      {editing ? (
                        <Input
                          type="date"
                          value={editExpiresAt}
                          onChange={(e) => setEditExpiresAt(e.target.value)}
                          className="w-40"
                          aria-label={t('admin.userDetail.services.expiresAria')}
                        />
                      ) : (
                        <span className="text-muted-foreground">
                          {formatDate(service.expiresAt, locale)}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {formatDate(service.createdAt, locale)}
                    </td>
                    <td className="px-3 py-2">
                      {editing ? (
                        <div className="flex items-center gap-1">
                          <Button
                            size="sm"
                            onClick={() => void saveEdit(service.id)}
                            disabled={isPending}
                          >
                            {t('common.save')}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                            {t('common.cancel')}
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1">
                          <Button size="sm" variant="outline" onClick={() => startEdit(service)}>
                            {t('common.edit')}
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => void remove(service.id)}
                            disabled={isPending}
                          >
                            {bound ? t('admin.userDetail.services.unbind') : t('common.delete')}
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <AlertDialog
        open={confirmTarget !== null}
        onOpenChange={(open) => {
          if (!open && !isPending) setConfirmTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmTarget?.bound ? t('admin.userDetail.services.unbind') : t('common.delete')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmTarget?.bound
                ? t('admin.userDetail.services.confirmUnbind')
                : t('admin.userDetail.services.confirmDelete')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant={confirmTarget?.bound ? 'outline' : 'destructive'}
              disabled={isPending}
              onClick={confirmRemove}
            >
              {confirmTarget?.bound ? t('admin.userDetail.services.unbind') : t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SectionCard>
  );
}

/** Ids of locally bound upstream services (so `remove` knows to unbind). */
function boundServiceIds(services: AdminUserDetailResponse['services']): Set<string> {
  return new Set(
    services
      .filter((service) => service.providerId && service.providerServiceId)
      .map((service) => service.id),
  );
}

function OrdersSection({
  orders,
  pagination,
}: {
  orders: AdminUserDetailResponse['orders'];
  pagination: AdminUserDetailResponse['ordersPagination'];
}) {
  const t = useTranslator();
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const { page, pageSize, total } = pagination ?? { page: 1, pageSize: 20, total: orders.length };
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const navigate = (next: number, size = pageSize) => {
    const query = new URLSearchParams(searchParams);
    query.set('orderPage', String(next));
    query.set('orderPageSize', String(size));
    startTransition(() => router.replace(`${pathname}?${query}`, { scroll: false }));
  };
  return (
    <SectionCard title={t('admin.userDetail.orders.title')}>
      {orders.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          {t('admin.userDetail.orders.empty')}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{t('admin.userDetail.orders.colId')}</th>
                <th className="px-3 py-2 font-medium">{t('admin.userDetail.orders.colAmount')}</th>
                <th className="px-3 py-2 font-medium">{t('admin.userDetail.orders.colStatus')}</th>
                <th className="px-3 py-2 font-medium">
                  {t('admin.userDetail.orders.colCreatedAt')}
                </th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.id} className="border-t">
                  <td className="px-3 py-2 font-mono text-xs">{order.id}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {money(order.total, order.currency, locale)}
                  </td>
                  <td className="px-3 py-2">{order.status}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {formatDate(order.createdAt, locale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3" aria-busy={pending}>
        <span className="text-sm text-muted-foreground">
          {t('admin.userDetail.orders.totalCount', { total })}
        </span>
        <div className="flex flex-wrap items-center gap-3">
          <Select
            value={String(pageSize)}
            onValueChange={(value) => {
              if (value) navigate(1, Number(value));
            }}
            disabled={pending}
          >
            <SelectTrigger aria-label={t('admin.userDetail.orders.rowsPerPageAria')}>
              <SelectValue>
                {t('admin.userDetail.orders.rowsPerPage', { size: pageSize })}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {[10, 20, 50, 100].map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {t('admin.userDetail.orders.rowsPerPage', { size })}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <span className="text-sm tabular-nums">
            {t('admin.userDetail.orders.pageOf', { page, pages })}
          </span>
          <Button
            size="icon-sm"
            variant="outline"
            aria-label={t('admin.userDetail.orders.prevPage')}
            disabled={pending || page <= 1}
            onClick={() => navigate(page - 1)}
          >
            <ChevronLeft />
          </Button>
          <Button
            size="icon-sm"
            variant="outline"
            aria-label={t('admin.userDetail.orders.nextPage')}
            disabled={pending || page >= pages}
            onClick={() => navigate(page + 1)}
          >
            <ChevronRight />
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}

export function AdminUserDetail({
  userId,
  initial,
  groups,
}: {
  userId: string;
  initial: AdminUserDetailResponse;
  groups: PermissionGroupView[];
}) {
  return (
    <div className="grid gap-5">
      <BasicInfoSection user={initial.user} />
      <GroupsSection
        userId={userId}
        currentGroupIds={initial.user.groups.map((group) => group.id)}
        groups={groups}
      />
      <WalletSection userId={userId} wallet={initial.wallet} ledger={initial.ledger} />
      <ServicesSection userId={userId} services={initial.services} />
      <OrdersSection orders={initial.orders} pagination={initial.ordersPagination} />
    </div>
  );
}
