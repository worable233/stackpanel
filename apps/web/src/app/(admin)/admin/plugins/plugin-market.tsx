'use client';

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import type { MarketPackage } from '@stackpanel/sdk';
import { Boxes, Download, RefreshCw, Search, Sparkles } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Badge, List, ListEmpty, ListItem, SectionTitle } from '@stackpanel/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { useTranslator } from '@/i18n/provider';

interface MarketState {
  plugins: MarketPackage[];
  themes: MarketPackage[];
}

const EMPTY: MarketState = { plugins: [], themes: [] };

/**
 * 插件目录。和「已安装」共用同一个页面，安装完立即回到可管理状态。
 * 数据走插件的 BFF 代理，页面不直接持有任何令牌。
 */
export function PluginMarket({
  query,
  onlyUpgradable = false,
}: {
  query: string;
  onlyUpgradable?: boolean;
}) {
  const t = useTranslator();
  const router = useRouter();
  const [data, setData] = useState<MarketState>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [pluginsResult, themesResult] = await Promise.allSettled([
        fetch('/api/plugins/market/admin/plugins', { cache: 'no-store' }),
        fetch('/api/plugins/market/admin/themes', { cache: 'no-store' }),
      ]);
      const read = async (result: PromiseSettledResult<Response>): Promise<MarketPackage[]> => {
        if (result.status !== 'fulfilled' || !result.value.ok) return [];
        const body = (await result.value.json().catch(() => null)) as {
          plugins?: MarketPackage[];
          themes?: MarketPackage[];
        } | null;
        return body?.plugins ?? body?.themes ?? [];
      };
      const [plugins, themes] = await Promise.all([read(pluginsResult), read(themesResult)]);
      if (plugins.length === 0 && themes.length === 0) setError(true);
      setData({ plugins, themes });
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const packages = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return [...data.plugins, ...data.themes]
      .filter((pkg) => {
        if (onlyUpgradable && !pkg.upgradable) return false;
        if (!normalized) return true;
        return [pkg.name, pkg.id, pkg.description, pkg.author].some((value) =>
          value?.toLocaleLowerCase().includes(normalized),
        );
      })
      .sort(
        (a, b) =>
          Number(b.upgradable) - Number(a.upgradable) || Number(a.installed) - Number(b.installed),
      );
  }, [data, onlyUpgradable, query]);

  function install(pkg: MarketPackage): void {
    setBusyId(pkg.id);
    startTransition(async () => {
      try {
        const resource = pkg.kind === 'theme' ? 'themes' : 'plugins';
        const response = await fetch(`/api/plugins/market/admin/${resource}/${pkg.id}/install`, {
          method: 'POST',
        });
        if (!response.ok) throw new Error('install failed');
        toast.success(
          t(pkg.installed ? 'admin.plugins.market.upgraded' : 'admin.plugins.market.installed', {
            name: pkg.name,
          }),
        );
        await load();
        router.refresh();
      } catch {
        toast.error(t('admin.plugins.market.installFailed'));
      } finally {
        setBusyId(null);
      }
    });
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <SectionTitle>{t('admin.plugins.market.title')}</SectionTitle>
          <Badge>{packages.length}</Badge>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw className={loading ? 'size-4 animate-spin' : 'size-4'} />
          {t('admin.plugins.market.refresh')}
        </Button>
      </div>

      {loading && packages.length === 0 ? (
        <ListEmpty>{t('admin.plugins.market.loading')}</ListEmpty>
      ) : error ? (
        <ListEmpty>{t('admin.plugins.market.error')}</ListEmpty>
      ) : packages.length === 0 ? (
        <ListEmpty>{t('admin.plugins.market.empty')}</ListEmpty>
      ) : (
        <List>
          {packages.map((pkg) => {
            const canInstall = !pkg.installed || pkg.upgradable;
            return (
              <ListItem
                key={`${pkg.kind}:${pkg.id}`}
                className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-background text-foreground">
                    {pkg.kind === 'theme' ? (
                      <Sparkles className="size-4" />
                    ) : (
                      <Boxes className="size-4" />
                    )}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-medium">{pkg.name}</p>
                      <Badge>
                        {pkg.kind === 'theme'
                          ? t('admin.plugins.market.kindTheme')
                          : t('admin.plugins.market.kindPlugin')}
                      </Badge>
                      {pkg.installed && pkg.current ? (
                        <Badge className="bg-primary/10 text-primary">
                          {t('admin.plugins.market.installedBadge')}
                        </Badge>
                      ) : pkg.upgradable ? (
                        <Badge className="bg-primary/10 text-primary">
                          {t('admin.plugins.market.upgradableBadge', { version: pkg.version })}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="line-clamp-2 text-sm text-muted-foreground">
                      {pkg.description || t('admin.plugins.market.noDescription')}
                    </p>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span className="font-mono">{pkg.id}</span>
                      <span>{t('admin.plugins.market.version', { version: pkg.version })}</span>
                      {pkg.installedVersion && pkg.installedVersion !== pkg.version ? (
                        <span>
                          {t('admin.plugins.market.installedVersion', {
                            version: pkg.installedVersion,
                          })}
                        </span>
                      ) : null}
                      {pkg.author ? (
                        <span>{t('admin.plugins.market.author', { author: pkg.author })}</span>
                      ) : null}
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center self-end sm:self-auto">
                  <Button
                    type="button"
                    size="sm"
                    variant={canInstall ? 'default' : 'outline'}
                    disabled={!canInstall || busyId !== null}
                    onClick={() => install(pkg)}
                  >
                    {canInstall ? <Download className="size-3.5" /> : null}
                    {busyId === pkg.id
                      ? t('admin.plugins.market.installing')
                      : pkg.upgradable
                        ? t('admin.plugins.market.upgrade')
                        : pkg.installed
                          ? t('admin.plugins.market.installedBadge')
                          : t('admin.plugins.market.install')}
                  </Button>
                </div>
              </ListItem>
            );
          })}
        </List>
      )}
    </section>
  );
}

/** 搜索框与目录共用；安装页与已安装页各自过滤。 */
export function PluginSearch({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useTranslator();
  return (
    <div className="relative w-full sm:max-w-sm">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t('admin.plugins.searchPlaceholder')}
        aria-label={t('admin.plugins.searchPlaceholder')}
        className="pl-8"
      />
    </div>
  );
}
