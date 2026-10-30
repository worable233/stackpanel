'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import type {
  UpdateCheckResponse,
  UpdatePlanResponse,
  UpdateResultsResponse,
  UpdateSelfUpdateResponse,
  UpdateStatusResponse,
  UpdateTaskResultView,
} from '@stackpanel/sdk';
import { ArrowUpCircle, Info, RefreshCw, Settings2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useTranslator } from '@/i18n/provider';
import {
  cancelSelfUpdateAction,
  checkUpdateCatalogAction,
  planUpdateAction,
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
  const [check, setCheck] = useState<UpdateCheckResponse | null>(null);
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

  function onCheck() {
    setFeedback(null);
    run('check', async () => {
      const next = await checkUpdateCatalogAction();
      if (next.error) {
        setFeedback({ kind: 'error', text: next.error });
        return;
      }
      if (next.check) setCheck(next.check);
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
      const upgradable = solved?.ok ? (solved.plan?.packages.length ?? 0) : 0;
      setFeedback({
        kind: 'ok',
        text:
          solved?.ok && upgradable > 0
            ? t('admin.updates.checkSucceeded', {
                sequence: String(result.catalog.sequence ?? 0),
              })
            : t('admin.updates.checkNoChanges'),
      });
    });
  }

  function onPlan() {
    setFeedback(null);
    setPlan(null);
    setAcknowledge(false);
    setAllowExpired(false);
    run('plan', async () => {
      const next = await planUpdateAction();
      if (next.error) {
        setFeedback({ kind: 'error', text: next.error });
        return;
      }
      if (next.plan) setPlan(next.plan);
    });
  }

  function onSubmit() {
    setFeedback(null);
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
  const hasUpdates = Boolean(plan?.ok && (plan.includesKernel || packages.length > 0));
  const targetVersion = plan?.ok ? plan.plan?.kernel.version : undefined;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <section className="rounded-3xl bg-muted/40 p-6 sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="flex flex-col gap-2">
            <span className="text-sm text-muted-foreground">
              {t('admin.updates.currentVersion')}
            </span>
            <span className="text-4xl font-semibold tracking-tight tabular-nums">
              v{currentVersion}
            </span>
            <p className="max-w-xl text-sm text-muted-foreground">
              {hasUpdates
                ? t('admin.updates.availableSummary', {
                    version: targetVersion ?? '',
                    count: packages.length,
                  })
                : plan
                  ? t('admin.updates.upToDateSummary')
                  : t('admin.updates.checkPrompt')}
            </p>
          </div>
          <Badge variant={hasUpdates ? 'default' : 'secondary'} className="mt-1">
            {hasUpdates
              ? t('admin.updates.availableBadge')
              : plan
                ? t('admin.updates.upToDateBadge')
                : t('admin.updates.notCheckedBadge')}
          </Badge>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-2">
          <Button type="button" onClick={onCheck} disabled={busy !== null}>
            <RefreshCw className="size-4" aria-hidden="true" />
            {busy === 'check' ? t('admin.updates.checking') : t('admin.updates.checkAction')}
          </Button>
          {hasUpdates && !needsConfirm ? (
            <Button type="button" onClick={onSubmit} disabled={busy !== null}>
              <ArrowUpCircle className="size-4" aria-hidden="true" />
              {t('admin.updates.submit')}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            onClick={() => setAdvancedOpen(true)}
          >
            <Settings2 className="size-4" aria-hidden="true" />
            {t('admin.updates.advancedInfo')}
          </Button>
        </div>
      </section>

      {feedback ? (
        feedback.kind === 'error' ? (
          <div className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <p>{t('admin.updates.actionFailed')}</p>
            <details className="mt-2 text-xs text-destructive/80">
              <summary className="cursor-pointer">{t('admin.updates.errorDetails')}</summary>
              <p className="mt-1 break-words">{feedback.text}</p>
            </details>
          </div>
        ) : (
          <div className="rounded-xl bg-muted px-4 py-3 text-sm text-foreground">
            {feedback.text}
          </div>
        )
      ) : null}

      {!plan && !activeTask ? (
        <section className="flex items-start gap-3 rounded-2xl bg-muted/40 p-5">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-background text-muted-foreground">
            <Info className="size-4" aria-hidden="true" />
          </span>
          <div className="flex flex-col gap-1.5 text-sm">
            <p className="font-medium">{t('admin.updates.beforeCheckTitle')}</p>
            <p className="text-muted-foreground">{t('admin.updates.beforeCheckBody')}</p>
          </div>
        </section>
      ) : null}

      {plan && !plan.ok ? (
        <section className="flex flex-col gap-2 rounded-2xl bg-destructive/10 p-5">
          <p className="text-sm font-medium text-destructive">{t('admin.updates.planBlocked')}</p>
          <ul className="list-disc pl-5 text-sm text-muted-foreground">
            {(plan.blocks ?? []).map((block, index) => (
              <li key={`${block.code}-${index}`}>
                {block.component
                  ? t('admin.updates.blockDetail', {
                      component: `${block.component.kind}/${block.component.id}`,
                      detail: block.detail,
                    })
                  : block.detail}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {hasUpdates ? (
        <section className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex flex-col gap-1">
              <h2 className="text-base font-semibold">{t('admin.updates.updateContentTitle')}</h2>
              {targetVersion ? (
                <p className="text-sm text-muted-foreground">
                  {t('admin.updates.targetVersion', { version: targetVersion })}
                </p>
              ) : null}
            </div>
            <span className="text-sm text-muted-foreground">
              {t('admin.updates.componentCount', { count: packages.length })}
            </span>
          </div>

          <ul className="flex flex-col gap-2">
            {plan?.includesKernel ? (
              <li className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-muted/40 px-4 py-3">
                <span className="text-sm font-medium">{t('admin.updates.kernelComponent')}</span>
                <span className="text-sm text-muted-foreground tabular-nums">
                  v{currentVersion}
                  {targetVersion ? ` → v${targetVersion}` : ''}
                </span>
              </li>
            ) : null}
            {packages.map((pkg) => (
              <li
                key={`${pkg.kind}/${pkg.id}`}
                className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-muted/40 px-4 py-3"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-sm font-medium">{pkg.id}</span>
                  <span className="text-xs text-muted-foreground">{pkg.kind}</span>
                </div>
                <span className="text-sm text-muted-foreground tabular-nums">
                  {pkg.fromVersion ?? '—'} → {pkg.toVersion}
                </span>
              </li>
            ))}
          </ul>

          {needsExpiredOverride ? (
            <p className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {t('admin.updates.expiredWarning')}
            </p>
          ) : null}

          {needsConfirm ? (
            <div className="flex flex-col gap-3 rounded-2xl bg-destructive/10 p-5">
              <p className="text-sm font-semibold">{t('admin.updates.authorizationTitle')}</p>
              <p className="text-sm text-muted-foreground">
                {t('admin.updates.authorizationBody')}
              </p>
              <ul className="list-disc pl-5 text-sm">
                {packages
                  .filter((pkg) => pkg.addsPermissions || !pkg.reversible)
                  .map((pkg) => (
                    <li key={`auth-${pkg.kind}/${pkg.id}`}>
                      {pkg.addsPermissions
                        ? t('admin.updates.authorizationPermissions', {
                            component: `${pkg.kind}/${pkg.id}`,
                          })
                        : t('admin.updates.authorizationIrreversible', {
                            component: `${pkg.kind}/${pkg.id}`,
                          })}
                    </li>
                  ))}
              </ul>
              {needsAck ? (
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="acknowledge"
                    checked={acknowledge}
                    onCheckedChange={(checked) => setAcknowledge(checked === true)}
                  />
                  <Label htmlFor="acknowledge">{t('admin.updates.acknowledgeLabel')}</Label>
                </div>
              ) : null}
              {needsExpiredOverride ? (
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="allowExpired"
                    checked={allowExpired}
                    onCheckedChange={(checked) => setAllowExpired(checked === true)}
                  />
                  <Label htmlFor="allowExpired">{t('admin.updates.allowExpiredLabel')}</Label>
                </div>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  onClick={onSubmit}
                  disabled={
                    busy !== null ||
                    (needsAck && !acknowledge) ||
                    (needsExpiredOverride && !allowExpired)
                  }
                >
                  {t('admin.updates.confirmSubmit')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setAcknowledge(false);
                    setAllowExpired(false);
                  }}
                  disabled={busy !== null}
                >
                  {t('admin.updates.cancel')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex justify-end">
              <Button type="button" onClick={onSubmit} disabled={busy !== null}>
                <ArrowUpCircle className="size-4" aria-hidden="true" />
                {t('admin.updates.submit')}
              </Button>
            </div>
          )}
        </section>
      ) : plan ? (
        <section className="flex flex-col items-center gap-2 rounded-2xl bg-muted/40 px-6 py-10 text-center">
          <p className="text-sm font-medium">{t('admin.updates.upToDateTitle')}</p>
          <p className="text-sm text-muted-foreground">{t('admin.updates.upToDateSummary')}</p>
        </section>
      ) : null}

      {activeTask ? (
        <section className="flex flex-col gap-2 rounded-2xl bg-muted/40 p-5">
          <h2 className="text-sm font-semibold">{t('admin.updates.progressTitle')}</h2>
          {activePhase(history, activeTask) ? (
            <p className="text-sm">
              {t('admin.updates.progressPhase', {
                phase: activePhase(history, activeTask) as string,
              })}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {t('admin.updates.progressHint', {
              seconds: String(POLL_INTERVAL_MS / 1000),
            })}
          </p>
        </section>
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
                    <dd className="max-w-[16rem] truncate font-mono">{status.status.digest ?? '—'}</dd>
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
                <p className="text-sm text-muted-foreground">{t('admin.updates.statusUnreadable')}</p>
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
                <Button type="button" size="sm" onClick={onCheck} disabled={busy !== null}>
                  {busy === 'check'
                    ? t('admin.updates.checking')
                    : t('admin.updates.checkAction')}
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
                  <span className="break-all font-mono text-xs">
                    {selfUpdate.candidateDigest}
                  </span>
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
                <Label htmlFor="candidateDigest">
                  {t('admin.updates.selfUpdateDigestLabel')}
                </Label>
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
