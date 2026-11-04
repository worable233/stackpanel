'use client';

import {
  ArrowDown,
  ArrowUp,
  ExternalLink,
  Info,
  ListTree,
  Plus,
  RotateCcw,
  Save,
  Trash2,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import type { AdminNavItemView } from '@stackpanel/sdk';
import { Badge, SectionTitle } from '@stackpanel/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import {
  addNavItemAction,
  deleteNavItemAction,
  saveNavLayoutAction,
  type NavSurface,
} from '@/lib/nav-actions';
import { useTranslator } from '@/i18n/provider';

interface Props {
  surface: NavSurface;
  items: AdminNavItemView[];
}

interface Row {
  href: string;
  label: string;
  hidden: boolean;
  custom: boolean;
  overrideId: string | null;
  defaultLabel: string | null;
}

function toRows(items: AdminNavItemView[]): Row[] {
  return items.map((item) => ({
    href: item.href,
    label: item.label,
    hidden: item.hidden,
    custom: item.custom,
    overrideId: item.overrideId,
    defaultLabel: item.defaultLabel,
  }));
}

/**
 * Saving the layout records an override row even when every value still equals
 * the default, so `overrideId` alone is not a reason to offer "reset". Only an
 * actual label change, a hidden entry, or a custom link is.
 */
function hasOverride(row: Row): boolean {
  return (
    row.custom || row.hidden || (row.defaultLabel !== null && row.label.trim() !== row.defaultLabel)
  );
}

/**
 * 后台菜单编辑（对标 #12.3）。
 *
 * 这里改的是「怎么显示」：顺序、文案、是否展示。隐藏一个菜单项**不会**让对应
 * 页面变得不可访问 —— 权限仍然由页面自己的守卫决定。界面里把这句话写出来，
 * 因为确实有人会把它当权限开关用。
 */
export function AdminNavManager({ surface, items }: Props) {
  const t = useTranslator();
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>(() => toRows(items));
  const [dirty, setDirty] = useState(false);
  const [pending, startTransition] = useTransition();
  const [label, setLabel] = useState('');
  const [href, setHref] = useState('');

  // `router.refresh()` re-renders the server component, but this client state
  // survives. Without this a newly added link (or a deleted override) would only
  // appear after a full reload. Unsaved edits win over the refresh.
  //
  // 用「key 重置」而不是 `useEffect`：React 官方对「props 变了就重置 state」
  // 的推荐做法。父组件在 `items` 变化时换一个 key，本组件的 state 就会自然
  // 重建，不需要在 effect 里 setState（那会触发级联渲染），也不需要渲染期
  // 读 ref（React 19 禁止）。
  //
  // 关键约束：**未保存的编辑必须赢过刷新**，否则用户正在改的链接会被
  // `router.refresh()` 冲掉。所以 key 由父组件只在 `dirty === false` 时递增。

  const move = (index: number, delta: number) => {
    const next = [...rows];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    const [row] = next.splice(index, 1);
    if (!row) return;
    next.splice(target, 0, row);
    setRows(next);
    setDirty(true);
  };

  const update = (index: number, patch: Partial<Row>) => {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
    setDirty(true);
  };

  const save = () => {
    startTransition(async () => {
      const result = await saveNavLayoutAction(
        surface,
        rows.map((row) => ({
          href: row.href,
          // 与默认文案一致时按「留空」处理，避免把默认文案复制成覆写。
          label: row.defaultLabel !== null && row.label === row.defaultLabel ? null : row.label,
          hidden: row.hidden,
        })),
      );
      if (result.error) {
        toast.error(result.error);
        return;
      }
      setDirty(false);
      toast.success(t('action.navSaved'));
      router.refresh();
    });
  };

  const add = () => {
    startTransition(async () => {
      const result = await addNavItemAction(surface, { label, href });
      if (result.error) {
        toast.error(result.error);
        return;
      }
      setLabel('');
      setHref('');
      toast.success(t('action.navItemAdded'));
      router.refresh();
    });
  };

  const remove = (row: Row) => {
    if (!row.overrideId) return;
    startTransition(async () => {
      const result = await deleteNavItemAction(row.overrideId as string);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success(t('action.navItemDeleted'));
      router.refresh();
    });
  };

  const visibleCount = rows.filter((row) => !row.hidden).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3 rounded-2xl bg-muted/40 p-4 text-sm text-muted-foreground">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl bg-background text-foreground">
          <Info className="size-4" />
        </span>
        <p className="min-w-0 leading-relaxed">{t('adminNav.presentationNote')}</p>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-start">
        <section className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-col gap-1">
              <SectionTitle icon={<ListTree />}>{t('adminNav.itemsTitle')}</SectionTitle>
              <p className="text-xs text-muted-foreground">{t('adminNav.saveHint')}</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                {t('adminNav.itemsCount', { visible: visibleCount, total: rows.length })}
              </span>
              <Button size="sm" onClick={save} disabled={!dirty || pending}>
                <Save className="size-4" />
                {pending ? t('adminNav.saving') : t('adminNav.save')}
              </Button>
            </div>
          </div>

          <ul className="flex flex-col gap-2">
            {rows.length === 0 ? (
              <li className="rounded-2xl bg-muted/40 px-4 py-10 text-center text-sm text-muted-foreground">
                {t('adminNav.empty')}
              </li>
            ) : null}
            {rows.map((row, index) => (
              <li
                key={`${row.href}-${row.overrideId ?? 'default'}`}
                className={cn(
                  'flex flex-col gap-3 rounded-2xl bg-muted/40 p-3.5 transition-opacity',
                  row.hidden && 'opacity-60',
                )}
              >
                <div className="flex flex-wrap items-start gap-3">
                  <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-background p-0.5">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t('adminNav.moveUp')}
                      disabled={index === 0 || pending}
                      onClick={() => move(index, -1)}
                    >
                      <ArrowUp className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t('adminNav.moveDown')}
                      disabled={index === rows.length - 1 || pending}
                      onClick={() => move(index, 1)}
                    >
                      <ArrowDown className="size-3.5" />
                    </Button>
                  </div>

                  <div className="min-w-0 flex-1">
                    <Input
                      value={row.label}
                      placeholder={row.defaultLabel ?? row.href}
                      maxLength={40}
                      aria-label={row.defaultLabel ?? row.href}
                      className="h-9 bg-background"
                      onChange={(event) => update(index, { label: event.target.value })}
                    />
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      <a
                        href={row.href}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex min-w-0 max-w-full items-center gap-1 truncate font-mono hover:text-foreground hover:underline"
                      >
                        <ExternalLink className="size-3 shrink-0" />
                        <span className="truncate">{row.href}</span>
                      </a>
                      {row.custom ? (
                        <Badge variant="secondary">{t('adminNav.custom')}</Badge>
                      ) : null}
                      {row.hidden ? <Badge variant="outline">{t('adminNav.hidden')}</Badge> : null}
                    </div>
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <label className="flex h-8 items-center gap-2 rounded-lg bg-background px-2.5 text-xs">
                      <Switch
                        checked={!row.hidden}
                        disabled={pending}
                        aria-label={t('adminNav.visible')}
                        onCheckedChange={(checked) => update(index, { hidden: !checked })}
                      />
                      <span>{t('adminNav.visible')}</span>
                    </label>
                    {row.overrideId && hasOverride(row) ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        className={cn(
                          row.custom &&
                            'text-destructive hover:bg-destructive/10 hover:text-destructive',
                        )}
                        onClick={() => remove(row)}
                      >
                        {row.custom ? (
                          <Trash2 className="size-4" />
                        ) : (
                          <RotateCcw className="size-4" />
                        )}
                        {row.custom ? t('adminNav.delete') : t('adminNav.reset')}
                      </Button>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <aside className="order-first flex flex-col gap-4 rounded-2xl bg-muted/40 p-4 xl:order-none xl:sticky xl:top-4">
          <SectionTitle icon={<Plus />}>{t('adminNav.addTitle')}</SectionTitle>
          <div className="flex flex-col gap-2">
            <Label htmlFor="nav-label">{t('adminNav.name')}</Label>
            <Input
              id="nav-label"
              value={label}
              maxLength={40}
              className="h-10 bg-background"
              onChange={(event) => setLabel(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="nav-href">{t('adminNav.href')}</Label>
            <Input
              id="nav-href"
              value={href}
              placeholder={t('adminNav.hrefPlaceholder')}
              className="h-10 bg-background"
              onChange={(event) => setHref(event.target.value)}
            />
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t('adminNav.hrefHint')}
            </p>
          </div>
          <Button
            variant="secondary"
            className="w-full"
            onClick={add}
            disabled={pending || !label.trim() || !href.trim()}
          >
            <Plus className="size-4" />
            {t('adminNav.add')}
          </Button>
        </aside>
      </div>
    </div>
  );
}
