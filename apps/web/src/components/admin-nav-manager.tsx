'use client';

import { ArrowDown, ArrowUp, Plus, RotateCcw, Save, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { AdminNavItemView } from '@stackpanel/sdk';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [label, setLabel] = useState('');
  const [href, setHref] = useState('');

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
    setError(null);
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
        setError(result.error);
        return;
      }
      setDirty(false);
      router.refresh();
    });
  };

  const add = () => {
    setError(null);
    startTransition(async () => {
      const result = await addNavItemAction(surface, { label, href });
      if (result.error) {
        setError(result.error);
        return;
      }
      setLabel('');
      setHref('');
      router.refresh();
    });
  };

  const remove = (row: Row) => {
    if (!row.overrideId) return;
    setError(null);
    startTransition(async () => {
      const result = await deleteNavItemAction(row.overrideId as string);
      if (result.error) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  };

  return (
    <div className="space-y-5">
      <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
        {t('adminNav.presentationNote')}
      </p>

      <ul className="divide-y rounded-lg border">
        {rows.map((row, index) => (
          <li key={row.href} className="flex flex-wrap items-center gap-2 px-3 py-2">
            <div className="flex flex-col">
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('adminNav.moveUp')}
                disabled={index === 0 || pending}
                onClick={() => move(index, -1)}
              >
                <ArrowUp className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('adminNav.moveDown')}
                disabled={index === rows.length - 1 || pending}
                onClick={() => move(index, 1)}
              >
                <ArrowDown className="size-3.5" />
              </Button>
            </div>
            <div className="min-w-40 flex-1">
              <Input
                value={row.label}
                placeholder={row.defaultLabel ?? row.href}
                maxLength={40}
                onChange={(event) => update(index, { label: event.target.value })}
              />
            </div>
            <a
              href={row.href}
              target="_blank"
              rel="noreferrer"
              className="max-w-64 truncate font-mono text-xs text-muted-foreground hover:underline"
            >
              {row.href}
            </a>
            <div className="flex items-center gap-3">
              {row.custom ? (
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
                  {t('adminNav.custom')}
                </span>
              ) : null}
              <label className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={!row.hidden}
                  onChange={(event) => update(index, { hidden: !event.target.checked })}
                />
                {t('adminNav.visible')}
              </label>
              {row.overrideId ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => remove(row)}
                >
                  {row.custom ? <Trash2 className="size-4" /> : <RotateCcw className="size-4" />}
                  {row.custom ? t('adminNav.delete') : t('adminNav.reset')}
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{t('adminNav.saveHint')}</p>
        <Button onClick={save} disabled={!dirty || pending}>
          <Save className="size-4" />
          {pending ? t('adminNav.saving') : t('adminNav.save')}
        </Button>
      </div>

      <div className="space-y-3 rounded-lg border p-3">
        <div className="text-sm font-medium">{t('adminNav.addTitle')}</div>
        <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
          <div className="space-y-1">
            <Label htmlFor="nav-label">{t('adminNav.name')}</Label>
            <Input
              id="nav-label"
              value={label}
              maxLength={40}
              onChange={(event) => setLabel(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="nav-href">{t('adminNav.href')}</Label>
            <Input
              id="nav-href"
              value={href}
              placeholder={t('adminNav.hrefPlaceholder')}
              onChange={(event) => setHref(event.target.value)}
            />
          </div>
          <div className="flex items-end">
            <Button variant="outline" onClick={add} disabled={pending}>
              <Plus className="size-4" />
              {t('adminNav.add')}
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t('adminNav.hrefHint')}</p>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
