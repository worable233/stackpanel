'use client';

/**
 * 市场后台页面（客户端交互部分）。
 *
 * 数据由内核在服务端经 finder 预取后通过 `props.data` 注入；安装通过声明的
 * plugin action（`props.actions`）执行——本组件不直接调用内核，也不持有令牌。
 */
import { useState, useTransition } from 'react';
import type { AdminPageComponentProps } from '@stackpanel/sdk';
import { Button, PageHeader } from '@stackpanel/ui';

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

function StatusBadge({ pkg }: { pkg: MarketPackageRow }) {
  if (pkg.installed && pkg.current) {
    return (
      <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-600">
        已安装
      </span>
    );
  }
  if (pkg.installed && pkg.upgradable) {
    return (
      <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-600">
        可升级至 {pkg.version}
      </span>
    );
  }
  if (pkg.installed) {
    return (
      <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
        已安装其他版本
      </span>
    );
  }
  return (
    <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">未安装</span>
  );
}

function MarketRow({
  pkg,
  action,
}: {
  pkg: MarketPackageRow;
  action: ((formData: FormData) => Promise<void>) | undefined;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const label = pkg.installed ? (pkg.upgradable ? `升级到 ${pkg.version}` : '重新安装') : '安装';

  return (
    <li className="flex items-start justify-between gap-4 rounded-lg border bg-card p-4 text-card-foreground">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium">{pkg.name}</p>
          <StatusBadge pkg={pkg} />
          {pkg.builtin ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              内置
            </span>
          ) : null}
        </div>
        {pkg.description ? (
          <p className="mt-1 text-sm text-muted-foreground">{pkg.description}</p>
        ) : null}
        <p className="mt-1 text-xs text-muted-foreground">
          {pkg.id} · v{pkg.version}
          {pkg.frontend?.available ? ` · 前端页面 ${pkg.frontend.pages.length}` : ''}
        </p>
        {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
      </div>
      <form
        className="shrink-0"
        onSubmit={(event) => {
          event.preventDefault();
          if (!action) {
            setError('安装动作不可用');
            return;
          }
          const formData = new FormData();
          formData.set('id', pkg.id);
          startTransition(async () => {
            setError(null);
            try {
              await action(formData);
            } catch {
              setError('安装失败，请重试');
            }
          });
        }}
      >
        <Button type="submit" variant="outline" size="sm" disabled={isPending || !action}>
          {isPending ? '处理中…' : label}
        </Button>
      </form>
    </li>
  );
}

function MarketSection({
  title,
  packages,
  action,
}: {
  title: string;
  packages: MarketPackageRow[];
  action: ((formData: FormData) => Promise<void>) | undefined;
}) {
  return (
    <section>
      <h2 className="text-lg font-semibold">{title}</h2>
      {packages.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {packages.map((pkg) => (
            <MarketRow key={`${pkg.kind}-${pkg.id}`} pkg={pkg} action={action} />
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">暂无可安装条目。</p>
      )}
    </section>
  );
}

function MarketAdminPage(props: AdminPageComponentProps) {
  const plugins = (props.data.plugins ?? []) as MarketPackageRow[];
  const themes = (props.data.themes ?? []) as MarketPackageRow[];
  const installPlugin = props.actions['market.install-plugin'];
  const installTheme = props.actions['market.install-theme'];

  return (
    <main className="w-full space-y-6">
      <PageHeader title="应用市场" description="浏览本地与已签名远程目录，安装或升级插件与主题。" />
      <div className="space-y-8">
        <MarketSection title="插件" packages={plugins} action={installPlugin} />
        <MarketSection title="主题" packages={themes} action={installTheme} />
      </div>
    </main>
  );
}

export const adminPages = {
  'admin/market': MarketAdminPage,
} as const;
