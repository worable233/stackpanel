'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Info, MoreHorizontal, Settings, Trash2 } from 'lucide-react';
import type { AdminPlugin, StalePluginRecord } from '@stackpanel/sdk';
import { Badge, List, ListEmpty, ListItem, SectionTitle } from '@stackpanel/ui';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { toast } from '@/components/ui/toast';
import { deletePluginAction, togglePluginAction } from '@/lib/plugin-actions';
import { useTranslator } from '@/i18n/provider';
import { PluginMarket, PluginSearch } from './plugin-market';

/** Interactive plugin manager: discover, install, enable/disable or remove. */
export function PluginManager({
  plugins,
  stale = [],
  initialTab = 'installed',
  onlyUpgradable = false,
}: {
  plugins: AdminPlugin[];
  /**
   * Rows whose package directory is gone. They are not loaded, so they cannot be
   * listed as plugins — but until they are removed the database keeps claiming
   * their capabilities exist.
   */
  stale?: StalePluginRecord[];
  initialTab?: 'installed' | 'market';
  onlyUpgradable?: boolean;
}) {
  const router = useRouter();
  const t = useTranslator();
  const [tab, setTab] = useState(initialTab);
  const [query, setQuery] = useState('');
  const [isMutating, startTransition] = useTransition();
  const [deleteTarget, setDeleteTarget] = useState<AdminPlugin | null>(null);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return plugins;
    return plugins.filter((plugin) =>
      [plugin.name, plugin.id, plugin.description].some((value) =>
        value?.toLocaleLowerCase().includes(normalized),
      ),
    );
  }, [plugins, query]);

  const mutate = async (form: FormData) => {
    startTransition(async () => {
      const deleting = form.get('_op') === 'delete';
      try {
        if (deleting) {
          await deletePluginAction(form);
          toast.success(t('admin.plugins.deleted'));
        } else {
          await togglePluginAction(form);
          toast.success(t('admin.plugins.toggled'));
        }
        router.refresh();
      } catch {
        toast.error(t('admin.plugins.mutationFailed'));
      }
    });
  };

  function toggle(plugin: AdminPlugin): void {
    const form = new FormData();
    form.set('_op', 'toggle');
    form.set('id', plugin.id);
    form.set('enabled', plugin.enabled ? 'false' : 'true');
    void mutate(form);
  }

  function confirmDelete(): void {
    if (!deleteTarget) return;
    const form = new FormData();
    form.set('_op', 'delete');
    form.set('id', deleteTarget.id);
    setDeleteTarget(null);
    void mutate(form);
  }

  return (
    <div className="flex flex-col gap-5">
      <Tabs value={tab} onValueChange={(value) => setTab(value as 'installed' | 'market')}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <TabsList>
            <TabsTrigger value="installed">
              {t('admin.plugins.tabs.installed')}
              <Badge>{plugins.length}</Badge>
            </TabsTrigger>
            <TabsTrigger value="market">{t('admin.plugins.tabs.discover')}</TabsTrigger>
          </TabsList>
          <PluginSearch value={query} onChange={setQuery} />
        </div>

        <TabsContent value="installed" className="mt-4 flex flex-col gap-5">
          {filtered.length === 0 ? (
            <ListEmpty>
              {query ? t('admin.plugins.noMatch') : t('admin.plugins.installedEmpty')}
            </ListEmpty>
          ) : (
            <List>
              {filtered.map((plugin) => (
                <ListItem
                  key={plugin.id}
                  className="relative flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-2 pr-10 sm:pr-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-medium">{plugin.name}</p>
                      <Badge className={plugin.enabled ? 'bg-primary/10 text-primary' : undefined}>
                        {plugin.enabled ? t('admin.plugins.enabled') : t('admin.plugins.disabled')}
                      </Badge>
                      {plugin.source === 'builtin' ? (
                        <Badge>{t('admin.plugins.builtin')}</Badge>
                      ) : null}
                      {plugin.dependencies.some((dependency) => !dependency.satisfied) ? (
                        <span
                          title={plugin.dependencies
                            .filter((dependency) => !dependency.satisfied)
                            .map(
                              (dependency) =>
                                `${dependency.id}${dependency.range ? `@${dependency.range}` : ''}`,
                            )
                            .join('\n')}
                        >
                          <Badge variant="destructive">
                            {plugin.dependencies.some(
                              (dependency) => !dependency.satisfied && dependency.installed,
                            )
                              ? t('admin.plugins.detail.depConflict')
                              : t('admin.plugins.detail.depMissing')}
                          </Badge>
                        </span>
                      ) : null}
                      {plugin.worker.circuitOpen ? (
                        <span title={t('admin.plugins.worker.circuitOpenHint')}>
                          <Badge variant="destructive" className="cursor-help">
                            {t('admin.plugins.worker.circuitOpen')}
                          </Badge>
                        </span>
                      ) : null}
                    </div>
                    {plugin.description ? (
                      <p className="line-clamp-2 text-sm text-muted-foreground">
                        {plugin.description}
                      </p>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span className="font-mono">{plugin.id}</span>
                      <span>v{plugin.version}</span>
                      {plugin.frontend.available && plugin.frontend.pages.length > 0 ? (
                        <span>
                          {t('admin.plugins.frontendPages', {
                            count: plugin.frontend.pages.length,
                          })}
                        </span>
                      ) : null}
                      {/*
                        前端装载失败必须在这里可见（P1-A）。
                        之前只写在 web 容器日志里，而插件列表仍显示
                        「已激活」—— 线上 llm-gateway 后台整个打不开，
                        管理员却完全无从得知。
                      */}
                      {plugin.frontend.runtimeLoadFailure ? (
                        <span
                          className="text-destructive"
                          title={plugin.frontend.runtimeLoadFailure.message}
                        >
                          {t('admin.plugins.frontendLoadFailed')}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="absolute top-3 right-3 flex shrink-0 items-center sm:static">
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={plugin.name}
                            disabled={isMutating}
                          />
                        }
                      >
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-44">
                        <DropdownMenuItem render={<Link href={`/admin/plugins/${plugin.id}`} />}>
                          <Info className="size-4" />
                          {t('admin.plugins.detailTrigger')}
                        </DropdownMenuItem>
                        {plugin.frontend.available ? (
                          <DropdownMenuItem
                            render={<Link href={`/admin/plugins/${plugin.id}/settings`} />}
                          >
                            <Settings className="size-4" />
                            {t('admin.plugins.settings')}
                          </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuItem onClick={() => toggle(plugin)}>
                          {plugin.enabled ? t('admin.plugins.disable') : t('admin.plugins.enable')}
                        </DropdownMenuItem>
                        {plugin.removable ? (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-destructive"
                              onClick={() => setDeleteTarget(plugin)}
                            >
                              <Trash2 className="size-4" />
                              {t('common.delete')}
                            </DropdownMenuItem>
                          </>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </ListItem>
              ))}
            </List>
          )}

          {stale.length > 0 ? (
            <section className="flex flex-col gap-3">
              <SectionTitle>{t('admin.plugins.stale.title')}</SectionTitle>
              <List>
                {stale.map((record) => (
                  <ListItem
                    key={record.id}
                    className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {record.name}
                        <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">
                          {record.id}@{record.version}
                        </span>
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {t('admin.plugins.stale.body')}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={isMutating}
                      onClick={() => {
                        const form = new FormData();
                        form.set('_op', 'delete');
                        form.set('id', record.id);
                        void mutate(form);
                      }}
                    >
                      {t('admin.plugins.stale.cleanup')}
                    </Button>
                  </ListItem>
                ))}
              </List>
            </section>
          ) : null}
        </TabsContent>

        <TabsContent value="market" className="mt-4">
          <PluginMarket query={query} onlyUpgradable={onlyUpgradable} />
        </TabsContent>
      </Tabs>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin.plugins.deleteConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('admin.plugins.deleteConfirmDescription', {
                name: deleteTarget?.name ?? '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>{t('common.delete')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
