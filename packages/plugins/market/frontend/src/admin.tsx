'use client';

/**
 * 市场后台页面（客户端交互部分）。
 *
 * 数据由内核在服务端经 finder 预取后通过 `props.data` 注入；安装通过声明的
 * plugin action（`props.actions`）执行——本组件不直接调用内核，也不持有令牌。
 *
 * Copy comes from this package's own catalog (`../messages/*.json`) resolved
 * with the locale the host passes in (ADR-0016 §5).
 */
import { useState, useTransition } from 'react';
import type { AdminPageComponentProps } from '@stackpanel/sdk';
import { Button, PageHeader } from '@stackpanel/ui';
import { messages, t } from './i18n.js';

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

function StatusBadge({ pkg, tr }: { pkg: MarketPackageRow; tr: ReturnType<typeof t> }) {
  if (pkg.installed && pkg.current) {
    return (
      <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-600">
        {tr('status.installed')}
      </span>
    );
  }
  if (pkg.installed && pkg.upgradable) {
    return (
      <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-600">
        {tr('status.upgradable', { version: pkg.version })}
      </span>
    );
  }
  if (pkg.installed) {
    return (
      <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
        {tr('status.otherVersion')}
      </span>
    );
  }
  return (
    <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
      {tr('status.notInstalled')}
    </span>
  );
}

function MarketRow({
  pkg,
  action,
  tr,
}: {
  pkg: MarketPackageRow;
  action: ((formData: FormData) => Promise<void>) | undefined;
  tr: ReturnType<typeof t>;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const label = pkg.installed
    ? pkg.upgradable
      ? tr('row.upgrade', { version: pkg.version })
      : tr('row.reinstall')
    : tr('row.install');

  return (
    <li className="flex items-start justify-between gap-4 rounded-lg border bg-card p-4 text-card-foreground">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium">{pkg.name}</p>
          <StatusBadge pkg={pkg} tr={tr} />
          {pkg.builtin ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {tr('badge.builtin')}
            </span>
          ) : null}
        </div>
        {pkg.description ? (
          <p className="mt-1 text-sm text-muted-foreground">{pkg.description}</p>
        ) : null}
        <p className="mt-1 text-xs text-muted-foreground">
          {pkg.id} · v{pkg.version}
          {pkg.frontend?.available
            ? tr('row.pages', { count: pkg.frontend.pages.length })
            : ''}
        </p>
        {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
      </div>
      <form
        className="shrink-0"
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
  tr: ReturnType<typeof t>;
}) {
  return (
    <section>
      <h2 className="text-lg font-semibold">{title}</h2>
      {packages.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {packages.map((pkg) => (
            <MarketRow key={`${pkg.kind}-${pkg.id}`} pkg={pkg} action={action} tr={tr} />
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">{tr('section.empty')}</p>
      )}
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
    warn: 'border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400',
    error: 'border-destructive/40 bg-destructive/5 text-destructive',
    info: 'border-border bg-muted/40 text-muted-foreground',
  } as const;

  return (
    <ul className="space-y-2">
      {notes.map((note, index) => (
        <li
          key={index}
          className={`rounded-lg border px-3 py-2 text-sm ${toneClass[note.tone]}`}
        >
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

  return (
    <main className="w-full space-y-6">
      <PageHeader title={tr('page.title')} description={tr('page.description')} />
      {status ? <SourceStatus status={status} tr={tr} /> : null}
      <div className="space-y-8">
        <MarketSection
          title={tr('section.plugins')}
          packages={plugins}
          action={installPlugin}
          tr={tr}
        />
        <MarketSection
          title={tr('section.themes')}
          packages={themes}
          action={installTheme}
          tr={tr}
        />
      </div>
    </main>
  );
}

export const adminPages = {
  'admin/market': MarketAdminPage,
} as const;
