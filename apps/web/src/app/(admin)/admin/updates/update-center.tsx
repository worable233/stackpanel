'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import type {
  UpdatePlanResponse,
  UpdateResultsResponse,
  UpdateSelfUpdateResponse,
  UpdateStatusResponse,
  UpdateTaskResultView,
} from '@stackpanel/sdk';
import { ArrowRight, ArrowUpCircle, CheckCircle2, Info, RefreshCw, Settings2 } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useTranslator } from '@/i18n/provider';
import {
  cancelSelfUpdateAction,
  checkUpdateCatalogAction,
  refreshUpdateSnapshotAction,
  submitSelfUpdateAction,
  submitUpdateAction,
} from '@/lib/update-actions';

/** 任务进行中的轮询间隔：足够看到阶段推进，又不至于把 API 打满。 */
const POLL_INTERVAL_MS = 4000;
/** 轮询上限（默认约 5 分钟）：updater 长时间不回写时不能无限轮询下去。 */
const POLL_MAX = 75;

type TaskResultRow = UpdateResultsResponse['results'][number];

/**
 * 更新中心（PLAN-github-distribution-and-updates §9）。
 *
 * 页面的职责边界在这里必须清楚：
 *
 * - **渲染不出网**。首屏数据由服务端组件用 `GET /admin/updates/status` 提供，那是一条
 *   纯只读投影；「检查更新」是唯一会触发目录请求的显式动作。
 * - **授权只能来自人**。`requiresAuthorization` 只用来**决定是否要求确认**；
 *   真正的 `acknowledge` 来自确认框里的勾选，绝不由计划字段派生。
 * - **过期目录默认禁止投递**。过期快照可以展示、可以求解（便于人工判断），
 *   但投递需要一个独立的「仍按过期目录投递」勾选。
 */
export function UpdateCenter({
  currentVersion,
  initial,
  initialResults,
  initialSelfUpdate,
}: {
  currentVersion: string;
  initial: UpdateStatusResponse;
  initialResults: TaskResultRow[];
  initialSelfUpdate: UpdateSelfUpdateResponse['request'];
}) {
  const t = useTranslator();
  const [status, setStatus] = useState<UpdateStatusResponse>(initial);
  const [results, setResults] = useState<TaskResultRow[]>(initialResults);
  const [selfUpdate, setSelfUpdate] =
    useState<UpdateSelfUpdateResponse['request']>(initialSelfUpdate);
  const [plan, setPlan] = useState<UpdatePlanResponse | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState<null | 'check' | 'plan' | 'submit' | 'self'>(null);
  const [acknowledge, setAcknowledge] = useState(false);
  const [allowExpired, setAllowExpired] = useState(false);
  const [digest, setDigest] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  /**
   * 已投递但还没看到结果回写的任务键。
   *
   * 提交后 `activeTask` 仍是 null（updater 还没认领），只靠它判断就看不到进度；
   * 这里记下自己投递的键，结果一出现就停止轮询。
   */
  const [watchingKey, setWatchingKey] = useState<string | null>(null);
  const polls = useRef(0);
  const [, startTransition] = useTransition();

  const activeTask = status.status?.activeTask ?? null;
  const catalog = status.catalogState;
  const history: TaskResultRow[] = results.length > 0 ? results : (status.status?.recent ?? []);
  /**
   * 没有执行器时投递只会产生一个永远停在「已投递」的任务。
   *
   * 标准 compose 默认不带 updater，所以这是**常见**状态而不是异常：以前这里只是
   * 在页面上提示一句「独立执行器状态不可读」，按钮仍然可点，toast 还说「可在更新
   * 中心查看结果」——于是用户投递了 11 个包升级，永远看不到结果。
   *
   * 判定口径：`status` 投影为 null 即视为执行器不在（该文件由 updater 自己写）。
   */
  const executorOffline = status.status === null;

  const refresh = useCallback(async () => {
    const next = await refreshUpdateSnapshotAction();
    if (next.error) {
      setFeedback({ kind: 'error', text: next.error });
      return;
    }
    if (next.status) setStatus(next.status);
    if (next.results) {
      setResults(next.results);
      // 结果回写出现即停止轮询：任务进入终态后没有新信息可等。
      if (watchingKey && next.results.some((row) => row.idempotencyKey === watchingKey)) {
        setWatchingKey(null);
      }
    }
    if (next.selfUpdate !== undefined) setSelfUpdate(next.selfUpdate);
  }, [watchingKey]);

  // 任务进行中才轮询；任务结束（`activeTask` 消失或结果已回写）即停止。
  useEffect(() => {
    if (!activeTask && !watchingKey) return;
    polls.current = 0;
    const timer = setInterval(() => {
      polls.current += 1;
      if (polls.current > POLL_MAX) {
        setWatchingKey(null);
        return;
      }
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [activeTask, watchingKey, refresh]);

  function run(kind: 'check' | 'plan' | 'submit' | 'self', task: () => Promise<void>) {
    setBusy(kind);
    startTransition(async () => {
      try {
        await task();
      } finally {
        setBusy(null);
      }
    });
  }

  function onCheck(silent = false) {
    if (!silent) setFeedback(null);
    run('check', async () => {
      const next = await checkUpdateCatalogAction();
      if (next.error) {
        setFeedback({ kind: 'error', text: next.error });
        return;
      }
      if (next.status) setStatus(next.status);
      const result = next.check;
      if (!result) return;
      if (result.throttled) {
        setFeedback({
          kind: 'ok',
          text: t('admin.updates.checkThrottled', {
            seconds: String(Math.max(1, Math.ceil(result.retryAtMs / 1000))),
          }),
        });
        return;
      }
      if (result.catalog.state === 'unconfigured') {
        setFeedback({ kind: 'error', text: t('admin.updates.checkUnconfigured') });
        return;
      }
      const solved = next.plan ?? result.plan;
      if (solved) setPlan(solved);
      if (result.catalog.failure) {
        setFeedback({
          kind: 'error',
          text: t('admin.updates.checkFailed', { message: result.catalog.failure.message }),
        });
        return;
      }
      if (silent) return;
      const upgradable = solved?.ok ? (solved.plan?.packages.length ?? 0) : 0;
      setFeedback({
        kind: 'ok',
        text:
          solved?.ok && (solved.includesKernel || upgradable > 0)
            ? t('admin.updates.checkSucceeded', {
                sequence: String(result.catalog.sequence ?? 0),
              })
            : t('admin.updates.checkNoChanges'),
      });
    });
  }

  function onSubmit() {
    setFeedback(null);
    // 没有执行器就不投递：任务会无限期停在「已投递」，而界面只会说「可在更新中心
    // 查看结果」。直接在按钮处拦住并说清楚原因（下方按钮本身也已置灰）。
    if (executorOffline) {
      setFeedback({ kind: 'error', text: t('admin.updates.executorOffline') });
      return;
    }
    run('submit', async () => {
      const next = await submitUpdateAction({ acknowledge, allowExpired });
      if (next.error) {
        setFeedback({ kind: 'error', text: next.error });
        void refresh();
        return;
      }
      setWatchingKey(next.taskKey ?? null);
      setFeedback({
        kind: 'ok',
        text: t('admin.updates.dispatched', { taskKey: (next.taskKey ?? '').slice(0, 12) }),
      });
      setAcknowledge(false);
      setAllowExpired(false);
      await refresh();
    });
  }

  function onSelfUpdate() {
    setFeedback(null);
    run('self', async () => {
      const formData = new FormData();
      formData.set('candidateDigest', digest);
      const next = await submitSelfUpdateAction({}, formData);
      if (next.error) {
        setFeedback({ kind: 'error', text: next.error });
        return;
      }
      setSelfUpdate(next.selfUpdate ?? null);
      setDigest('');
      setFeedback({
        kind: 'ok',
        text: next.message ?? t('admin.updates.selfUpdateSubmitted'),
      });
    });
  }

  function onCancelSelfUpdate() {
    setFeedback(null);
    run('self', async () => {
      const next = await cancelSelfUpdateAction();
      if (next.error) {
        setFeedback({ kind: 'error', text: next.error });
        return;
      }
      setSelfUpdate(next.selfUpdate ?? null);
      setFeedback({ kind: 'ok', text: next.message ?? t('admin.updates.selfUpdateCancelled') });
    });
  }

  const needsAck = plan?.ok === true && plan.requiresAuthorization === true;
  const needsExpiredOverride = plan?.ok === true && plan.catalogExpired === true;
  const needsConfirm = needsAck || needsExpiredOverride;
  const packages = plan?.ok ? (plan.plan?.packages ?? []) : [];
  const targetVersion = plan?.ok ? plan.plan?.kernel.version : undefined;
  const hasKernelUpdate = Boolean(
    plan?.ok && plan.includesKernel && targetVersion && targetVersion !== currentVersion,
  );
  // `fromVersion === null` 表示目录里新增的包，不是「可更新」；
  // 把它算进去会让人以为已装的东西过期了。
  const pluginUpdates = packages.filter((item) => item.fromVersion !== null);
  const pluginUpdateCount = pluginUpdates.length;
  const checked = plan?.ok === true;
  const canSubmit =
    hasKernelUpdate &&
    (!needsAck || acknowledge) &&
    (!needsExpiredOverride || allowExpired) &&
    !executorOffline;
  const autoChecked = useRef(false);

  useEffect(() => {
    if (autoChecked.current || plan || activeTask) return;
    if (status.catalogState === 'unconfigured') return;
    autoChecked.current = true;
    onCheck(true);
    // 只在首屏自动检查一次；后续由用户显式触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex w-full flex-col gap-6">
      <section className="rounded-[28px] bg-muted/35 p-6 sm:p-8">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-5">
            <div className="flex flex-col gap-1">
              <span className="text-sm text-muted-foreground">
                {t('admin.updates.currentVersion')}
              </span>
              <span className="text-4xl font-semibold tracking-tight tabular-nums">
                v{currentVersion}
              </span>
            </div>
            {hasKernelUpdate ? (
              <>
                <ArrowRight className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="flex flex-col gap-1">
                  <span className="text-sm text-muted-foreground">
                    {t('admin.updates.newVersion')}
                  </span>
                  <span className="text-4xl font-semibold tracking-tight tabular-nums">
                    v{targetVersion}
                  </span>
                </div>
              </>
            ) : (
              <div className="flex items-center gap-2 rounded-full bg-background px-3 py-1.5 text-sm font-medium">
                <CheckCircle2 className="size-4" aria-hidden="true" />
                {checked ? t('admin.updates.upToDateBadge') : t('admin.updates.notCheckedBadge')}
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {hasKernelUpdate ? (
              <Button onClick={onSubmit} disabled={busy !== null || !canSubmit}>
                {busy === 'submit' ? t('admin.updates.updating') : t('admin.updates.updateNow')}
              </Button>
            ) : null}
            <Button
              type="button"
              variant={hasKernelUpdate ? 'outline' : 'default'}
              onClick={() => onCheck()}
              disabled={busy !== null || activeTask !== null}
            >
              <RefreshCw
                className={busy === 'check' ? 'size-4 animate-spin' : 'size-4'}
                aria-hidden="true"
              />
              {busy === 'check' ? t('admin.updates.checking') : t('admin.updates.checkAction')}
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={t('admin.updates.advancedInfo')}
              onClick={() => setAdvancedOpen(true)}
            >
              <Settings2 className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </div>

        {hasKernelUpdate || !checked ? (
          <p className="mt-5 text-sm text-muted-foreground">
            {hasKernelUpdate
              ? t('admin.updates.kernelUpdatePending', {
                  version: targetVersion ?? '',
                })
              : t('admin.updates.checkingUpdates')}
          </p>
        ) : null}

        {pluginUpdateCount > 0 ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-background px-4 py-3 text-sm">
            <span>{t('admin.updates.pluginUpdatesAvailable', { count: pluginUpdateCount })}</span>
            <Button
              variant="ghost"
              size="sm"
              render={<Link href="/admin/plugins?tab=market&updates=1" />}
            >
              {t('admin.updates.managePlugins')}
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </Button>
          </div>
        ) : null}

        {activeTask ? (
          <p className="mt-4 text-sm text-muted-foreground">
            {t('admin.updates.progressPhase', { phase: activePhase(results, activeTask) ?? '—' })}
          </p>
        ) : null}
      </section>

      {needsConfirm ? (
        <section className="flex flex-col gap-3 rounded-2xl bg-muted/40 p-5">
          <h2 className="text-sm font-semibold">{t('admin.updates.authorizationTitle')}</h2>
          <p className="text-sm text-muted-foreground">{t('admin.updates.authorizationBody')}</p>
          {needsAck ? (
            <label className="flex items-start gap-2.5 text-sm">
              <Checkbox
                checked={acknowledge}
                onCheckedChange={(value) => setAcknowledge(value === true)}
              />
              <span>{t('admin.updates.acknowledgeLabel')}</span>
            </label>
          ) : null}
          {needsExpiredOverride ? (
            <label className="flex items-start gap-2.5 text-sm">
              <Checkbox
                checked={allowExpired}
                onCheckedChange={(value) => setAllowExpired(value === true)}
              />
              <span>{t('admin.updates.allowExpiredLabel')}</span>
            </label>
          ) : null}
        </section>
      ) : null}

      {executorOffline && (hasKernelUpdate || activeTask) ? (
        <p className="rounded-2xl bg-muted/35 px-4 py-3 text-sm text-muted-foreground">
          {t('admin.updates.executorOffline')}
        </p>
      ) : null}

      {feedback ? (
        <p
          className={
            feedback.kind === 'error'
              ? 'rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive'
              : 'rounded-2xl bg-muted/35 px-4 py-3 text-sm text-muted-foreground'
          }
        >
          {feedback.text}
        </p>
      ) : null}

      <Sheet open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <SheetContent side="right" className="w-full max-w-md overflow-y-auto p-0">
          <SheetHeader className="p-5 pb-2">
            <SheetTitle>{t('admin.updates.advancedInfo')}</SheetTitle>
          </SheetHeader>
          <div className="flex flex-col gap-7 p-5">
            <section className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold">{t('admin.updates.currentDeployment')}</h3>
              {status.status ? (
                <dl className="grid gap-x-4 gap-y-2 text-sm">
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">{t('admin.updates.generation')}</dt>
                    <dd className="font-mono">{status.status.generation}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">{t('admin.updates.digest')}</dt>
                    <dd className="max-w-[16rem] truncate font-mono">
                      {status.status.digest ?? '—'}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">{t('admin.updates.carrier')}</dt>
                    <dd className="font-mono">{status.carrier}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">{t('admin.updates.updatedAt')}</dt>
                    <dd>{new Date(status.status.updatedAt).toLocaleString()}</dd>
                  </div>
                </dl>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t('admin.updates.statusUnreadable')}
                </p>
              )}
            </section>

            <section className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold">{t('admin.updates.catalogRepository')}</h3>
                <Badge variant={catalogBadgeVariant(catalog)}>
                  {t(`admin.updates.catalogState${capitalize(catalog)}`)}
                </Badge>
                {status.catalogExpired === true ? (
                  <Badge variant="destructive">{t('admin.updates.catalogExpiredBadge')}</Badge>
                ) : status.catalogExpired === false ? (
                  <Badge variant="outline">{t('admin.updates.catalogFreshBadge')}</Badge>
                ) : null}
              </div>
              <dl className="grid gap-x-4 gap-y-2 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{t('admin.updates.catalogRepository')}</dt>
                  <dd className="max-w-[16rem] truncate font-mono">
                    {status.catalogRepository ?? '—'}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{t('admin.updates.catalogChannel')}</dt>
                  <dd className="font-mono">{status.catalogChannel ?? '—'}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{t('admin.updates.catalogSequence')}</dt>
                  <dd className="font-mono">{status.catalogSequence ?? '—'}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{t('admin.updates.catalogGeneratedAt')}</dt>
                  <dd>
                    {status.catalogGeneratedAt
                      ? new Date(status.catalogGeneratedAt).toLocaleString()
                      : '—'}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{t('admin.updates.lastCheckedLabel')}</dt>
                  <dd>
                    {status.lastCheckedAt
                      ? new Date(status.lastCheckedAt).toLocaleString()
                      : t('admin.updates.lastCheckedNever')}
                  </dd>
                </div>
              </dl>
              {catalog === 'unconfigured' ? (
                <p className="text-sm text-muted-foreground">
                  {t('admin.updates.catalogMissingHint')}
                </p>
              ) : null}
              {status.catalogFailure ? (
                <p className="text-sm text-destructive">
                  {t('admin.updates.checkFailed', { message: status.catalogFailure.message })}
                </p>
              ) : null}
              <div>
                <Button type="button" size="sm" onClick={() => onCheck()} disabled={busy !== null}>
                  {busy === 'check' ? t('admin.updates.checking') : t('admin.updates.checkAction')}
                </Button>
              </div>
            </section>

            <section className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold">{t('admin.updates.selfUpdateTitle')}</h3>
              <p className="text-sm text-muted-foreground">
                {t('admin.updates.selfUpdateDescription')}
              </p>
              {selfUpdate ? (
                <div className="flex flex-col gap-2 rounded-xl bg-muted/40 p-3 text-sm">
                  <span className="break-all font-mono text-xs">{selfUpdate.candidateDigest}</span>
                  <span className="text-xs text-muted-foreground">
                    {t('admin.updates.selfUpdatePending', {
                      digest: selfUpdate.candidateDigest,
                      requestedBy: selfUpdate.requestedBy,
                      requestedAt: new Date(selfUpdate.requestedAt).toLocaleString(),
                    })}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={onCancelSelfUpdate}
                    disabled={busy !== null}
                  >
                    {t('admin.updates.selfUpdateCancel')}
                  </Button>
                </div>
              ) : null}
              <div className="flex flex-col gap-2">
                <Label htmlFor="candidateDigest">{t('admin.updates.selfUpdateDigestLabel')}</Label>
                <Input
                  id="candidateDigest"
                  value={digest}
                  onChange={(event) => setDigest(event.target.value)}
                  placeholder="sha256:…"
                  maxLength={300}
                />
                <p className="text-xs text-muted-foreground">
                  {t('admin.updates.selfUpdateDigestHint')}
                </p>
                <div>
                  <Button
                    type="button"
                    size="sm"
                    onClick={onSelfUpdate}
                    disabled={busy !== null || digest.trim().length === 0}
                  >
                    {t('admin.updates.selfUpdateSubmit')}
                  </Button>
                </div>
              </div>
            </section>

            <section className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold">{t('admin.updates.historyTitle')}</h3>
              {history.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('admin.updates.historyEmpty')}</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {history.map((entry) => (
                    <li key={entry.idempotencyKey} className="rounded-xl bg-muted/40 p-3">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <Badge variant={resultBadgeVariant(entry.result)}>
                          {entry.result.phase}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {new Date(entry.result.checkpoints?.[0]?.at ?? '').toLocaleString()}
                        </span>
                      </div>
                      {entry.result.block ? (
                        <p className="mt-2 text-xs text-destructive">
                          {entry.result.block.code}: {entry.result.block.detail}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

/** `unconfigured` → `Unconfigured`，用于拼接 `catalogState*` 消息 id。 */
function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`;
}

function catalogBadgeVariant(
  state: UpdateStatusResponse['catalogState'],
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (state) {
    case 'ready':
      return 'default';
    case 'failed':
      return 'destructive';
    case 'pending':
      return 'secondary';
    default:
      return 'outline';
  }
}

function resultBadgeVariant(
  result: UpdateTaskResultView,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (result.block || result.phase === 'recovery_failed') return 'destructive';
  if (result.phase === 'recovered' || result.phase === 'recovering') return 'secondary';
  if (result.phase === 'committed') return 'default';
  return 'outline';
}

/** 进行中任务的当前阶段：结果回写里可能已经有阶段凭据。 */
function activePhase(rows: TaskResultRow[], key: string): string | null {
  const row = rows.find((entry) => entry.idempotencyKey === key);
  return row?.result.phase ?? null;
}
