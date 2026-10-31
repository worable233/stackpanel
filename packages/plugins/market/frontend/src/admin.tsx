'use client';

/**
 * 市场后台页面（客户端交互部分）。
 *
 * 数据由内核经 finder 预取，安装由声明的 plugin action 执行。本组件只负责
 * 目录浏览、筛选和操作反馈，不持有令牌，也不复制安装逻辑。
 *
 * 反馈语义见 `docs/design/feedback-ux-handoff.md` §4：action 对业务结果**返回**
 * `{ ok, message?, error? }`（不再用 redirect 表达），所以行内能显示服务端给的
 * 精确原因——「前端文件超限 / 签名验不过 / 条目不在目录」这类失败不能再被压成
 * 一句「安装失败，请重试」。
 */
import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { AdminPageComponentProps, PluginActionResult } from '@stackpanel/sdk';
import { Button, InlineError, Input, PageHeader, StatusBadge } from '@stackpanel/ui';
import {
  ArrowDownToLine,
  Blocks,
  LoaderCircle,
  PackageSearch,
  Palette,
  RefreshCw,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { t } from './i18n.js';

type MarketAction = ((formData: FormData) => Promise<PluginActionResult | void>) | undefined;

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
  source?: 'local' | 'catalog';
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
    return (
      <StatusBadge tone="warn">{tr('status.upgradable', { version: pkg.version })}</StatusBadge>
    );
  }
  if (pkg.installed) {
    return <StatusBadge tone="neutral">{tr('status.otherVersion')}</StatusBadge>;
  }
  return <StatusBadge tone="neutral">{tr('status.notInstalled')}</StatusBadge>;
}

/**
 * Where an install would read from. Without this an operator cannot tell a
 * signature-verified catalog package from the repository checkout that shadows
 * it (local sources win on merge).
 */
function SourceBadge({ pkg, tr }: { pkg: MarketPackageRow; tr: Translator }) {
  if (pkg.source === 'catalog') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <ShieldCheck aria-hidden="true" className="size-3.5" />
        {tr('source.catalog')}
      </span>
    );
  }
  if (pkg.source === 'local') {
    return <span className="text-xs text-muted-foreground">{tr('source.local')}</span>;
  }
  return null;
}

/** Keep the server's precise reason; only transport faults fall back to a generic line. */
function failureMessage(error: unknown, tr: Translator): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return tr('error.installFailed');
}

function MarketRow({
  pkg,
  action,
  busy,
  onBusy,
  tr,
}: {
  pkg: MarketPackageRow;
  action: MarketAction;
  /** Another row is installing: concurrent installs restart several workers at once. */
  busy: boolean;
  onBusy: (id: string | null) => void;
  tr: Translator;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // ADR-0012 keeps the server `detail` out of the UI, so a stable message alone
  // is a dead end. The request id is what the operator greps the log with.
  const [errorRef, setErrorRef] = useState<string | null>(null);
  // 即时回执：安装成功的可见变化往往是「版本号没变」，没有这行用户无法确定
  // 刚刚那一下到底做了什么（生命周期通知要等通知拉取才到）。
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const overwrite = pkg.installed;
  const label = !overwrite
    ? tr('row.install')
    : pkg.upgradable
      ? tr('row.upgrade', { version: pkg.version })
      : tr('row.reinstall');
  const ActionIcon = isPending ? LoaderCircle : overwrite ? RefreshCw : ArrowDownToLine;
  const PackageIcon = pkg.kind === 'plugin' ? Blocks : Palette;
  const disabled = isPending || busy || !action;

  function install(): void {
    if (!action) {
      setError(tr('error.actionUnavailable'));
      setErrorRef(null);
      return;
    }
    onBusy(pkg.id);
    startTransition(async () => {
      setError(null);
      setErrorRef(null);
      setNotice(null);
      try {
        const formData = new FormData();
        formData.set('id', pkg.id);
        const result = await action(formData);
        // Success is reported inline, not as a toast: the lifecycle notification
        // already covers the toast, and two receipts for one click read as noise.
        if (result && result.ok === false) {
          setError(result.error ?? tr('error.installFailed'));
          setErrorRef(result.requestId ?? null);
        } else {
          setNotice(result?.message ?? tr('row.installedNow', { version: pkg.version }));
        }
      } catch (caught) {
        setError(failureMessage(caught, tr));
        setErrorRef(
          caught && typeof caught === 'object' && 'requestId' in caught
            ? String((caught as { requestId?: unknown }).requestId)
            : null,
        );
      } finally {
        setConfirming(false);
        onBusy(null);
      }
    });
  }

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
            {pkg.builtin ? (
              <span className="text-xs text-muted-foreground">{tr('badge.builtin')}</span>
            ) : (
              <SourceBadge pkg={pkg} tr={tr} />
            )}
          </div>
          {pkg.description ? (
            <p className="mt-1 line-clamp-2 text-sm leading-5 text-muted-foreground">
              {pkg.description}
            </p>
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
          {errorRef ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {tr('row.requestId', { requestId: errorRef })}
            </p>
          ) : null}
          {notice ? <p className="mt-2 text-xs text-success">{notice}</p> : null}
        </div>
      </div>
      {/* Built-in packages ship with the kernel and have no catalog entry, so the
          button could only ever fail in the production (local-sources-off) form. */}
      {pkg.builtin ? (
        <p className="shrink-0 pl-12 text-xs text-muted-foreground sm:max-w-40 sm:pl-0 sm:text-right">
          {tr('row.builtinHint')}
        </p>
      ) : (
        <form
          className="shrink-0 pl-12 sm:pl-0"
          onSubmit={(event) => {
            event.preventDefault();
            if (disabled) return;
            // Overwriting a live package unregisters and re-registers it; the
            // runtime keeps serving the old definition only on rollback.
            if (overwrite && !confirming) {
              setConfirming(true);
              return;
            }
            install();
          }}
        >
          <Button
            type="submit"
            variant={confirming ? 'destructive' : 'outline'}
            size="sm"
            disabled={disabled}
            title={
              confirming
                ? tr('row.confirmHint', { version: pkg.installedVersion ?? pkg.version })
                : undefined
            }
          >
            <ActionIcon
              className={isPending ? 'animate-spin' : undefined}
              data-icon="inline-start"
            />
            {isPending
              ? tr('row.working')
              : confirming
                ? tr('row.confirm', { version: pkg.installedVersion ?? pkg.version })
                : label}
          </Button>
        </form>
      )}
    </li>
  );
}

function MarketSection({
  title,
  packages,
  action,
  busyId,
  onBusy,
  tr,
}: {
  title: string;
  packages: MarketPackageRow[];
  action: MarketAction;
  busyId: string | null;
  onBusy: (id: string | null) => void;
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
            <MarketRow
              key={`${pkg.kind}-${pkg.id}`}
              pkg={pkg}
              action={action}
              busy={busyId !== null && busyId !== pkg.id}
              onBusy={onBusy}
              tr={tr}
            />
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
    expiresAt?: string;
    /** 上次真的发起过检查的时间；用于区分「刷新过但没变」与「从未刷新」。 */
    checkedAt?: string;
    failure?: { kind: string; message: string; retryAt?: string };
  };
}

/**
 * 来源健康度。
 *
 * 默认远程源开启后，「目录取不到」与「本地来源在容器里被禁用」都会让列表看起来
 * 是空的。没有这条提示，运维只会看到「暂无可安装条目」而无从判断是没发布、验签
 * 失败还是网络问题。健康时也不能沉默：装的是哪一版目录、什么时候过期，直接决定
 * 「我装的到底是哪份签名清单」。
 */
function SourceStatus({
  status,
  locale,
  tr,
}: {
  status: MarketStatusView;
  locale: string;
  tr: Translator;
}) {
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

  const toneClass = {
    warn: 'plugin-alert plugin-alert-warn',
    error: 'plugin-alert plugin-alert-error',
    info: 'plugin-alert plugin-alert-info',
  } as const;

  const healthy =
    status.catalog.configured && status.catalog.available && !status.catalog.expired
      ? catalogSnapshotLine(status.catalog, locale, tr)
      : null;

  if (notes.length === 0 && !healthy) return null;

  return (
    <div className="space-y-2">
      {healthy ? <p className="text-xs text-muted-foreground">{healthy}</p> : null}
      {notes.length > 0 ? (
        <ul className="space-y-2">
          {notes.map((note, index) => (
            <li key={index} className={toneClass[note.tone]}>
              {note.text}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** `目录序列 6 · 稳定版 · 2026-11-14 08:00 过期` for the healthy catalog case. */
function catalogSnapshotLine(
  catalog: MarketStatusView['catalog'],
  locale: string,
  tr: Translator,
): string {
  const parts: string[] = [];
  if (catalog.sequence !== undefined) {
    parts.push(tr('catalog.sequence', { sequence: catalog.sequence }));
  }
  if (catalog.channel) parts.push(tr('catalog.channel', { channel: catalog.channel }));
  if (catalog.expiresAt) {
    const expires = new Date(catalog.expiresAt);
    if (!Number.isNaN(expires.getTime())) {
      const formatted = new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(expires);
      parts.push(tr('catalog.expiresAt', { date: formatted }));
    }
  }
  // 「上次检查」是冷启动场景下唯一能回答「目录到底是不是卡住了」的信息：
  // 渲染路径不出网，没有这行只能看到「等待首次刷新」而永远不知道要不要动手。
  if (catalog.checkedAt) {
    const checked = new Date(catalog.checkedAt);
    if (!Number.isNaN(checked.getTime())) {
      const formatted = new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(checked);
      parts.push(tr('catalog.checkedAt', { date: formatted }));
    }
  }
  return parts.join(' · ');
}

/**
 * 手动刷新目录快照。
 *
 * 进程重启后目录快照只活在内存里，而页面渲染路径**不出网**（ADR-0027），所以
 * 冷启动时列表只能是空的、状态只能写「等待首次刷新」。没有这个按钮，唯一能触发
 * 刷新的入口藏在 `/admin/updates` 的「检查更新」里——运维会直接判定目录坏了。
 */
function CatalogRefresh({
  action,
  tr,
}: {
  action: MarketAction;
  tr: Translator;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [note, setNote] = useState<{ tone: 'success' | 'warn'; text: string } | null>(null);

  function run(): void {
    if (!action) {
      setNote({ tone: 'warn', text: tr('error.actionUnavailable') });
      return;
    }
    startTransition(async () => {
      setNote(null);
      try {
        const result = await action(new FormData());
        if (result && result.ok === false) {
          // 限流/离线/取不到都是失败：按钮不能报成功，否则运维以为目录是好的。
          setNote({ tone: 'warn', text: result.error ?? tr('error.installFailed') });
          return;
        }
        setNote({ tone: 'success', text: tr('catalog.refreshed') });
        // 快照变了，条目也得重拉：finder 是页面渲染时取的数据。
        router.refresh();
      } catch (caught) {
        setNote({ tone: 'warn', text: failureMessage(caught, tr) });
      }
    });
  }

  return (
    <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
      <Button type="button" variant="outline" size="sm" disabled={isPending || !action} onClick={run}>
        <RefreshCw
          className={isPending ? 'animate-spin' : undefined}
          data-icon="inline-start"
          aria-hidden="true"
        />
        {isPending ? tr('catalog.refreshing') : tr('catalog.refresh')}
      </Button>
      {note ? (
        <p
          className={note.tone === 'success' ? 'text-xs text-success' : 'text-xs text-warning'}
          role={note.tone === 'success' ? undefined : 'alert'}
        >
          {note.text}
        </p>
      ) : null}
    </div>
  );
}

function MarketAdminPage(props: AdminPageComponentProps) {
  const tr = t(props.locale);
  const plugins = (props.data.plugins ?? []) as MarketPackageRow[];
  const themes = (props.data.themes ?? []) as MarketPackageRow[];
  const status = (props.data.status ?? null) as MarketStatusView | null;
  const installPlugin = props.actions['market.install-plugin'] as MarketAction;
  const installTheme = props.actions['market.install-theme'] as MarketAction;
  const refreshCatalog = props.actions['market.refresh-catalog'] as MarketAction;
  const [filter, setFilter] = useState<MarketFilter>('all');
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const matches = (pkg: MarketPackageRow) =>
      (filter === 'all' || pkg.kind === filter) &&
      (!normalized ||
        [pkg.name, pkg.id, pkg.description, pkg.author].some((value) =>
          value?.toLocaleLowerCase().includes(normalized),
        ));
    return {
      plugins: plugins.filter(matches),
      themes: themes.filter(matches),
    };
  }, [filter, plugins, query, themes]);
  const visibleCount = filtered.plugins.length + filtered.themes.length;
  const installedCount = [...plugins, ...themes].filter((pkg) => pkg.installed).length;
  const upgradeCount = [...plugins, ...themes].filter(
    (pkg) => pkg.installed && pkg.upgradable,
  ).length;
  const filters: MarketFilter[] = ['all', 'plugin', 'theme'];

  return (
    <main className="flex w-full flex-col gap-5">
      <PageHeader title={tr('page.title')} description={tr('page.description')} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          {status ? (
            <SourceStatus status={status} locale={props.locale ?? 'zh-CN'} tr={tr} />
          ) : null}
        </div>
        <CatalogRefresh action={refreshCatalog} tr={tr} />
      </div>

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
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
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
        <span className="px-2" aria-hidden="true">
          ·
        </span>
        {tr('summary.installed', { count: installedCount })}
        <span className="px-2" aria-hidden="true">
          ·
        </span>
        {tr('summary.upgradable', { count: upgradeCount })}
      </p>

      {visibleCount === 0 ? (
        <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
          <PackageSearch aria-hidden="true" className="size-5 opacity-60" />
          <p className="text-sm">{query.trim() ? tr('search.empty') : tr('section.empty')}</p>
        </div>
      ) : null}
      {visibleCount > 0 && filter !== 'theme' && filtered.plugins.length > 0 ? (
        <MarketSection
          title={tr('section.plugins')}
          packages={filtered.plugins}
          action={installPlugin}
          busyId={busyId}
          onBusy={setBusyId}
          tr={tr}
        />
      ) : null}
      {visibleCount > 0 && filter !== 'plugin' && filtered.themes.length > 0 ? (
        <MarketSection
          title={tr('section.themes')}
          packages={filtered.themes}
          action={installTheme}
          busyId={busyId}
          onBusy={setBusyId}
          tr={tr}
        />
      ) : null}
    </main>
  );
}

export const adminPages = {
  'admin/market': MarketAdminPage,
} as const;
