'use client';

/**
 * 市场后台页面（客户端交互部分）。
 *
 * 数据由内核经 finder 预取，安装由声明的 plugin action 执行。本组件只负责
 * 目录浏览、筛选和操作反馈，不持有令牌，也不复制安装逻辑。
 */
import { useMemo, useState, useTransition } from 'react';
import type { AdminPageComponentProps } from '@stackpanel/sdk';
import { Button, InlineError, Input, PageHeader, StatusBadge } from '@stackpanel/ui';
import { ArrowDownToLine, Blocks, LoaderCircle, PackageSearch, Palette, RefreshCw, Search } from 'lucide-react';
import { t } from './i18n.js';

interface MarketPackageRow {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  kind: 'plugin' | 'theme';
  installed: boolean;
  installedVersion?: string | null;
  upgradable: boolean;
  current: boolean;
  builtin: boolean;
  frontend?: {
    available: boolean;
    pages: Array<{ path: string; component: string }>;
    finders: string[];
  };
}

type MarketFilter = 'all' | 'plugin' | 'theme';
type Translator = ReturnType<typeof t>;

function PackageStatus({ pkg, tr }: { pkg: MarketPackageRow; tr: Translator }) {
  if (pkg.installed && pkg.current) {
    return <StatusBadge tone="ok">{tr('status.installed')}</StatusBadge>;
  }
  if (pkg.installed && pkg.upgradable) {
    return <StatusBadge tone="warn">{tr('status.upgradable', { version: pkg.version })}</StatusBadge>;
  }
  if (pkg.installed) {
    return <StatusBadge tone="neutral">{tr('status.otherVersion')}</StatusBadge>;
  }
  return <StatusBadge tone="neutral">{tr('status.notInstalled')}</StatusBadge>;
}

function MarketRow({
  pkg,
  action,
  tr,
}: {
  pkg: MarketPackageRow;
  action: ((formData: FormData) => Promise<void>) | undefined;
  tr: Translator;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const label = pkg.installed
    ? pkg.upgradable
      ? tr('row.upgrade', { version: pkg.version })
      : tr('row.reinstall')
    : tr('row.install');
  const ActionIcon = isPending ? LoaderCircle : pkg.installed ? RefreshCw : ArrowDownToLine;
  const PackageIcon = pkg.kind === 'plugin' ? Blocks : Palette;

  return (
    <li className="plugin-row flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <span className="plugin-icon-tile mt-0.5">
          <PackageIcon aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-medium">{pkg.name}</h3>
            <PackageStatus pkg={pkg} tr={tr} />
            {pkg.builtin ? <span className="text-xs text-muted-foreground">{tr('badge.builtin')}</span> : null}
          </div>
          {pkg.description ? (
            <p className="mt-1 line-clamp-2 text-sm leading-5 text-muted-foreground">{pkg.description}</p>
          ) : null}
          <p className="mt-1.5 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
            <span>{pkg.id}</span>
            <span aria-hidden="true">·</span>
            <span>{tr('row.version', { version: pkg.version })}</span>
            {pkg.installedVersion ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{tr('row.installedVersion', { version: pkg.installedVersion })}</span>
              </>
            ) : null}
            {pkg.author ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{tr('row.author', { author: pkg.author })}</span>
              </>
            ) : null}
            {pkg.frontend?.available ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{tr('row.pages', { count: pkg.frontend.pages.length })}</span>
              </>
            ) : null}
          </p>
          {error ? <InlineError className="mt-2">{error}</InlineError> : null}
        </div>
      </div>
      <form
        className="shrink-0 pl-12 sm:pl-0"
        onSubmit={(event) => {
          event.preventDefault();
          if (!action) {
            setError(tr('error.actionUnavailable'));
            return;
          }
          const formData = new FormData();
          formData.set('id', pkg.id);
          startTransition(async () => {
            setError(null);
            try {
              await action(formData);
            } catch {
              setError(tr('error.installFailed'));
            }
          });
        }}
      >
        <Button type="submit" variant="outline" size="sm" disabled={isPending || !action}>
          <ActionIcon className={isPending ? 'animate-spin' : undefined} data-icon="inline-start" />
          {isPending ? tr('row.working') : label}
        </Button>
      </form>
    </li>
  );
}

function MarketSection({
  title,
  packages,
  action,
  tr,
}: {
  title: string;
  packages: MarketPackageRow[];
  action: ((formData: FormData) => Promise<void>) | undefined;
  tr: Translator;
}) {
  return (
    <section aria-label={title}>
      <div className="plugin-header flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="text-xs tabular-nums text-muted-foreground">{packages.length}</span>
      </div>
      {packages.length > 0 ? (
        <ul>
          {packages.map((pkg) => (
            <MarketRow key={`${pkg.kind}-${pkg.id}`} pkg={pkg} action={action} tr={tr} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

interface MarketStatusView {
  localSources: { enabled: boolean; reason?: string };
  catalog: {
    configured: boolean;
    repository: string | null;
    channel: string | null;
    available: boolean;
    sequence?: number;
    expired?: boolean;
    failure?: { kind: string; message: string; retryAt?: string };
  };
}

/**
 * 来源健康度横幅。
 *
 * 默认远程源开启后，「目录取不到」与「本地来源在容器里被禁用」都会让列表看起来
 * 是空的。没有这条提示，运维只会看到「暂无可安装条目」而无从判断是没发布、验签
 * 失败还是网络问题。
 */
function SourceStatus({ status, tr }: { status: MarketStatusView; tr: ReturnType<typeof t> }) {
  const notes: Array<{ tone: 'warn' | 'error' | 'info'; text: string }> = [];

  if (!status.localSources.enabled) {
    notes.push({
      tone: 'info',
      text: tr('source.localDisabled', { reason: status.localSources.reason ?? '' }),
    });
  }
  if (!status.catalog.configured) {
    notes.push({ tone: 'info', text: tr('source.catalogOffline') });
  } else if (status.catalog.failure) {
    notes.push({
      tone: 'error',
      text: tr('source.catalogFailed', { message: status.catalog.failure.message }),
    });
  } else if (!status.catalog.available) {
    notes.push({
      tone: 'warn',
      text: tr('source.catalogPending', { repository: status.catalog.repository ?? '' }),
    });
  } else if (status.catalog.expired) {
    notes.push({ tone: 'warn', text: tr('source.catalogExpired') });
  }

  if (notes.length === 0) return null;

  const toneClass = {
    warn: 'plugin-alert plugin-alert-warn',
    error: 'plugin-alert plugin-alert-error',
    info: 'plugin-alert plugin-alert-info',
  } as const;

  return (
    <ul className="space-y-2">
      {notes.map((note, index) => (
        <li key={index} className={toneClass[note.tone]}>
          {note.text}
        </li>
      ))}
    </ul>
  );
}

function MarketAdminPage(props: AdminPageComponentProps) {
  const tr = t(props.locale);
  const plugins = (props.data.plugins ?? []) as MarketPackageRow[];
  const themes = (props.data.themes ?? []) as MarketPackageRow[];
  const status = (props.data.status ?? null) as MarketStatusView | null;
  const installPlugin = props.actions['market.install-plugin'];
  const installTheme = props.actions['market.install-theme'];
  const [filter, setFilter] = useState<MarketFilter>('all');
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const matches = (pkg: MarketPackageRow) =>
      (filter === 'all' || pkg.kind === filter) &&
      (!normalized || [pkg.name, pkg.id, pkg.description, pkg.author].some((value) => value?.toLocaleLowerCase().includes(normalized)));
    return {
      plugins: plugins.filter(matches),
      themes: themes.filter(matches),
    };
  }, [filter, plugins, query, themes]);
  const visibleCount = filtered.plugins.length + filtered.themes.length;
  const installedCount = [...plugins, ...themes].filter((pkg) => pkg.installed).length;
  const upgradeCount = [...plugins, ...themes].filter((pkg) => pkg.installed && pkg.upgradable).length;
  const filters: MarketFilter[] = ['all', 'plugin', 'theme'];

  return (
    <main className="flex w-full flex-col gap-5">
      <PageHeader title={tr('page.title')} description={tr('page.description')} />
      {status ? <SourceStatus status={status} tr={tr} /> : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="plugin-segmented inline-flex w-fit items-center">
          {filters.map((value) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={filter === value ? 'secondary' : 'ghost'}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {tr(`filter.${value}`)}
            </Button>
          ))}
        </div>
        <label className="relative block w-full sm:max-w-xs">
          <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={tr('search.placeholder')}
            aria-label={tr('search.label')}
            className="pl-9"
          />
        </label>
      </div>

      <p className="text-xs text-muted-foreground">
        {tr('summary.visible', { visible: visibleCount, total: plugins.length + themes.length })}
        <span className="px-2" aria-hidden="true">·</span>
        {tr('summary.installed', { count: installedCount })}
        <span className="px-2" aria-hidden="true">·</span>
        {tr('summary.upgradable', { count: upgradeCount })}
      </p>

      {visibleCount === 0 ? (
        <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
          <PackageSearch aria-hidden="true" className="size-5 opacity-60" />
          <p className="text-sm">{query.trim() ? tr('search.empty') : tr('section.empty')}</p>
        </div>
      ) : null}
      {visibleCount > 0 && filter !== 'theme' && filtered.plugins.length > 0 ? (
        <MarketSection title={tr('section.plugins')} packages={filtered.plugins} action={installPlugin} tr={tr} />
      ) : null}
      {visibleCount > 0 && filter !== 'plugin' && filtered.themes.length > 0 ? (
        <MarketSection title={tr('section.themes')} packages={filtered.themes} action={installTheme} tr={tr} />
      ) : null}
    </main>
  );
}

export const adminPages = {
  'admin/market': MarketAdminPage,
} as const;
