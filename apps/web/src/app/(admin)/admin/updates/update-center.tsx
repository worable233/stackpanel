'use client';

import { useState, useTransition } from 'react';
import type { UpdatePlanResponse, UpdateStatusResponse } from '@stackpanel/sdk';
import { useRouter } from 'next/navigation';
import {
  planUpdateAction,
  refreshUpdateStatusAction,
  submitUpdateAction,
} from '@/lib/update-actions';

/**
 * Update center (PLAN §9): shows the updater projection and catalog state,
 * lets an admin solve the full deployment plan, review block reasons /
 * required authorizations, and submit a declarative update task.
 *
 * Every action goes through a server action to the admin update API; the
 * actual deployment is executed out-of-band by the independent updater
 * (which is the only process holding the Docker socket).
 */
export function UpdateCenter({ initial }: { initial: UpdateStatusResponse }) {
  const router = useRouter();
  const [status, setStatus] = useState(initial);
  const [plan, setPlan] = useState<UpdatePlanResponse | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function solvePlan(): void {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const result = await planUpdateAction();
      if (result.error) {
        setPlan(null);
        setError(result.error);
        return;
      }
      setPlan(result.plan ?? null);
    });
  }

  function submit(acknowledge: boolean): void {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const result = await submitUpdateAction(acknowledge);
      if (result.error) {
        setError(result.error);
        return;
      }
      setMessage(result.message ?? '升级任务已投递');
      const refreshed = await refreshUpdateStatusAction();
      if (refreshed.status) setStatus(refreshed.status);
      router.refresh();
    });
  }

  const planBlocked = plan && !plan.ok;
  const planReady = plan?.ok === true;

  return (
    <div className="space-y-6">
      <section className="rounded-lg border p-4">
        <h2 className="mb-2 text-lg font-semibold">当前部署</h2>
        {status.status ? (
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-muted-foreground">代次</dt>
            <dd>{status.status.generation}</dd>
            <dt className="text-muted-foreground">摘要</dt>
            <dd className="truncate">{status.status.digest ?? '—'}</dd>
            <dt className="text-muted-foreground">进行中任务</dt>
            <dd>{status.status.activeTask ?? '空闲'}</dd>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">独立执行器状态不可读（可能未运行）。</p>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          远程目录：
          {status.catalogConfigured
            ? status.catalogExpired
              ? '已配置（快照过期）'
              : '已配置'
            : '未配置（离线）'}
          ｜渠道：{status.policy.channel}｜自动更新：{status.policy.autoUpdate ? '开启' : '关闭'}
          ｜实例：{status.instanceId}
        </p>
      </section>

      <section className="rounded-lg border p-4">
        <div className="mb-3 flex gap-2">
          <button
            type="button"
            className="rounded border px-3 py-1 text-sm disabled:opacity-50"
            onClick={solvePlan}
            disabled={pending || !status.catalogConfigured}
          >
            求解升级计划
          </button>
          {planReady ? (
            <button
              type="button"
              className="rounded border px-3 py-1 text-sm disabled:opacity-50"
              onClick={() => submit(plan.requiresAuthorization === true)}
              disabled={pending}
            >
              {plan.requiresAuthorization ? '确认并投递（含授权变更）' : '投递升级任务'}
            </button>
          ) : null}
        </div>
        {!status.catalogConfigured ? (
          <p className="text-sm text-muted-foreground">未配置远程目录，无法求解远程升级计划。</p>
        ) : null}
        {planBlocked ? (
          <div className="text-sm text-destructive">
            <p className="font-medium">计划被阻止：</p>
            <ul className="list-disc pl-5">
              {plan?.blocks?.map((block, i) => (
                <li key={i}>
                  {block.component ? `${block.component.kind}/${block.component.id}：` : ''}
                  {block.detail}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {planReady ? (
          <div className="text-sm">
            <p>
              计划摘要：<code className="text-xs">{plan?.planDigest?.slice(0, 16)}…</code>
              {plan?.requiresAuthorization ? '（含需人工授权的变更）' : ''}
            </p>
            {plan?.includesKernel ? (
              <p className="mt-1 text-muted-foreground">
                含内核自身升级：<code className="text-xs">{plan.plan?.kernel.version}</code>
                {plan.plan?.kernel.migration ? `（迁移 ${plan.plan.kernel.migration}）` : ''}
              </p>
            ) : null}
            <table className="mt-2 w-full text-left text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1">组件</th>
                  <th>从</th>
                  <th>到</th>
                  <th>权限</th>
                  <th>可回退</th>
                </tr>
              </thead>
              <tbody>
                {(plan?.plan?.packages ?? []).map((pkg) => (
                  <tr key={`${pkg.kind}/${pkg.id}`} className="border-t">
                    <td className="py-1">
                      {pkg.kind}/{pkg.id}
                    </td>
                    <td>{pkg.fromVersion ?? '—'}</td>
                    <td>{pkg.toVersion}</td>
                    <td>{pkg.addsPermissions ? '新增' : '无'}</td>
                    <td>{pkg.reversible ? '是' : '否'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {message ? <p className="text-sm text-emerald-600">{message}</p> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
