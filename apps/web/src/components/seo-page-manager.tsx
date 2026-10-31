'use client';

import { Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import type { SeoPageView } from '@stackpanel/sdk';
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
} from '@/components/ui/dialog';
import { deleteSeoPageAction, saveSeoPageAction } from '@/lib/seo-actions';
import { useTranslator } from '@/i18n/provider';

interface Props {
  pages: SeoPageView[];
  total: number;
  page: number;
  pageSize: number;
  query: string;
}

interface Draft {
  path: string;
  title: string;
  description: string;
  ogImage: string;
  canonical: string;
  noindex: boolean;
}

const emptyDraft: Draft = {
  path: '',
  title: '',
  description: '',
  ogImage: '',
  canonical: '',
  noindex: false,
};

function toDraft(row: SeoPageView): Draft {
  return {
    path: row.path,
    title: row.title ?? '',
    description: row.description ?? '',
    ogImage: row.ogImage ?? '',
    canonical: row.canonical ?? '',
    noindex: row.noindex,
  };
}

/**
 * 逐页 SEO 覆写编辑（对标 #12.4）。
 *
 * 刻意不给「批量导入」之类的入口：覆写是运营的逐页决定，批量改标题最容易把
 * provider 提供的实体元数据（JSON-LD 等）覆盖成同一份文案。
 */
export function SeoPageManager({ pages, total, page, pageSize, query }: Props) {
  const t = useTranslator();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<SeoPageView | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [open, setOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SeoPageView | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const openCreate = () => {
    setEditing(null);
    setDraft(emptyDraft);
    setOpen(true);
  };

  const openEdit = (row: SeoPageView) => {
    setEditing(row);
    setDraft(toDraft(row));
    setOpen(true);
  };

  const submit = () => {
    const payload = { ...draft };
    startTransition(async () => {
      const result = await saveSeoPageAction(payload);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      setOpen(false);
      toast.success(t('action.seoPageSaved'));
      router.refresh();
    });
  };

  const confirmDelete = () => {
    const target = deleteTarget;
    if (!target) return;
    startTransition(async () => {
      const result = await deleteSeoPageAction(target.id);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      setDeleteTarget(null);
      toast.success(t('action.seoPageDeleted'));
      router.refresh();
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <form action="/admin/seo" method="get" className="flex items-center gap-2">
          <Input
            name="query"
            defaultValue={query}
            placeholder={t('adminSeo.searchPlaceholder')}
            className="w-56"
          />
          <Button type="submit" variant="outline" size="sm">
            <Search className="size-4" />
            {t('adminSeo.search')}
          </Button>
        </form>
        <Button size="sm" onClick={openCreate}>
          <Plus className="size-4" />
          {t('adminSeo.new')}
        </Button>
      </div>

      {pages.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          {t('adminSeo.empty')}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{t('adminSeo.path')}</th>
                <th className="px-3 py-2 font-medium">{t('adminSeo.titleField')}</th>
                <th className="px-3 py-2 font-medium">{t('adminSeo.noindex')}</th>
                <th className="px-3 py-2 font-medium">{t('adminSeo.updated')}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {pages.map((row) => (
                <tr key={row.id} className="border-t">
                  <td className="px-3 py-2 font-mono text-xs">{row.path}</td>
                  <td className="px-3 py-2">
                    {row.title ?? <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-3 py-2">
                    {row.noindex ? (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
                        {t('adminSeo.noindexOn')}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {t('adminSeo.noindexOff')}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {new Date(row.updatedAt).toLocaleString()}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(row)}>
                        <Pencil className="size-4" />
                        {t('adminSeo.edit')}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(row)}>
                        <Trash2 className="size-4" />
                        {t('adminSeo.delete')}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 ? (
        <div className="flex items-center justify-end gap-2 text-sm">
          <span className="text-muted-foreground">
            {t('adminSeo.pagination', { page, total: totalPages })}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() =>
              router.push(`/admin/seo?page=${page - 1}&query=${encodeURIComponent(query)}`)
            }
          >
            {t('adminSeo.prev')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() =>
              router.push(`/admin/seo?page=${page + 1}&query=${encodeURIComponent(query)}`)
            }
          >
            {t('adminSeo.next')}
          </Button>
        </div>
      ) : null}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? t('adminSeo.editTitle') : t('adminSeo.newTitle')}</DialogTitle>
            <DialogDescription>{t('adminSeo.formHint')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="seo-path">{t('adminSeo.path')}</Label>
              <Input
                id="seo-path"
                value={draft.path}
                disabled={editing !== null}
                placeholder="/products/1"
                onChange={(event) => setDraft({ ...draft, path: event.target.value })}
              />
              <p className="text-xs text-muted-foreground">{t('adminSeo.pathHint')}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="seo-title">{t('adminSeo.titleField')}</Label>
              <Input
                id="seo-title"
                value={draft.title}
                maxLength={200}
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="seo-description">{t('adminSeo.descriptionField')}</Label>
              <textarea
                id="seo-description"
                value={draft.description}
                rows={3}
                maxLength={500}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="seo-og">{t('adminSeo.ogImage')}</Label>
                <Input
                  id="seo-og"
                  value={draft.ogImage}
                  placeholder="/og/about.png"
                  onChange={(event) => setDraft({ ...draft, ogImage: event.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="seo-canonical">{t('adminSeo.canonical')}</Label>
                <Input
                  id="seo-canonical"
                  value={draft.canonical}
                  placeholder="/about"
                  onChange={(event) => setDraft({ ...draft, canonical: event.target.value })}
                />
              </div>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.noindex}
                className="mt-0.5"
                onChange={(event) => setDraft({ ...draft, noindex: event.target.checked })}
              />
              <span>
                {t('adminSeo.noindex')}
                <span className="block text-xs text-muted-foreground">
                  {t('adminSeo.noindexHint')}
                </span>
              </span>
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              {t('adminSeo.cancel')}
            </Button>
            <Button onClick={submit} disabled={pending}>
              {pending ? t('adminSeo.saving') : t('adminSeo.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('adminSeo.deleteTitle')}</DialogTitle>
            <DialogDescription>
              {t('adminSeo.deleteDescription', { path: deleteTarget?.path ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={pending}>
              {t('adminSeo.cancel')}
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={pending}>
              {t('adminSeo.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
