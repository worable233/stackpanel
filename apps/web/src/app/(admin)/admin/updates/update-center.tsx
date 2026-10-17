'use client';

import { useState, useTransition } from 'react';
import type { UpdatePlanResponse, UpdateStatusResponse } from '@stackpanel/sdk';
import { useRouter } from 'next/navigation';
import {
  planUpdateAction,
  refreshUpdateStatusAction,
  submitUpdateAction,
} from '@/lib/update-actions';
import { useTranslator } from '@/i18n/provider';

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
  const t = useTranslator();
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
      setMessage(t('admin.updates.dispatched', { taskKey: result.taskKey ?? '' }));
      const refreshed = await refreshUpdateStatusAction();
      if (refreshed.status) setStatus(refreshed.status);
      router.refresh();
    });
  }

  const planBlocked = plan && !plan.ok;
  const planReady = plan?.ok === true;
  const catalogLabel = status.catalogConfigured
    ? status.catalogExpired
      ? t('admin.updates.catalogConfiguredExpired')
      : t('admin.updates.catalogConfigured')
    : t('admin.updates.catalogMissing');

  return (
    <div className="space-y-6">
      <section className="rounded-lg border p-4">
        <h2 className="mb-2 text-lg font-semibold">{t('admin.updates.currentDeployment')}</h2>
        {status.status ? (
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-muted-foreground">{t('admin.updates.generation')}</dt>
            <dd>{status.status.generation}</dd>
            <dt className="text-muted-foreground">{t('admin.updates.digest')}</dt>
            <dd className="truncate">{status.status.digest ?? '—'}</dd>
            <dt className="text-muted-foreground">{t('admin.updates.activeTask')}</dt>
            <dd>{status.status.activeTask ?? t('admin.updates.idle')}</dd>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">{t('admin.updates.statusUnreadable')}</p>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          {t('admin.updates.catalogLine', {
            catalog: catalogLabel,
            channel: status.policy.channel,
            autoUpdate: status.policy.autoUpdate
              ? t('common.enabled')
              : t('common.disabled'),
            instance: status.instanceId,
          })}
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
            {t('admin.updates.solvePlan')}
          </button>
          {planReady ? (
            <button
              type="button"
              className="rounded border px-3 py-1 text-sm disabled:opacity-50"
              onClick={() => submit(plan.requiresAuthorization === true)}
              disabled={pending}
            >
              {plan.requiresAuthorization
                ? t('admin.updates.submitWithAuthorization')
                : t('admin.updates.submit')}
            </button>
          ) : null}
        </div>
        {!status.catalogConfigured ? (
          <p className="text-sm text-muted-foreground">{t('admin.updates.catalogMissingHint')}</p>
        ) : null}
        {planBlocked ? (
          <div className="text-sm text-destructive">
            <p className="font-medium">{t('admin.updates.planBlocked')}</p>
            <ul className="list-disc pl-5">
              {plan?.blocks?.map((block, i) => (
                <li key={i}>
                  {block.component
                    ? t('admin.updates.blockDetail', {
                        component: `${block.component.kind}/${block.component.id}`,
                        detail: block.detail,
                      })
                    : block.detail}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {planReady ? (
          <div className="text-sm">
            <p>
              {plan?.requiresAuthorization
                ? t('admin.updates.planDigestWithAuthorization', {
                    digest: plan?.planDigest?.slice(0, 16) ?? '',
                  })
                : t('admin.updates.planDigest', {
                    digest: plan?.planDigest?.slice(0, 16) ?? '',
                  })}
            </p>
            {plan?.includesKernel && plan.plan?.kernel ? (
              <p className="mt-1 text-muted-foreground">
                {plan.plan.kernel.migration
                  ? t('admin.updates.includesKernelMigration', {
                      version: plan.plan.kernel.version,
                      migration: plan.plan.kernel.migration,
                    })
                  : t('admin.updates.includesKernel', {
                      version: plan.plan.kernel.version,
                    })}
              </p>
            ) : null}
            <table className="mt-2 w-full text-left text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1">{t('admin.updates.colComponent')}</th>
                  <th>{t('admin.updates.colFrom')}</th>
                  <th>{t('admin.updates.colTo')}</th>
                  <th>{t('admin.updates.colPermissions')}</th>
                  <th>{t('admin.updates.colReversible')}</th>
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
                    <td>
                      {pkg.addsPermissions
                        ? t('admin.updates.addsPermissions')
                        : t('admin.updates.noPermissions')}
                    </td>
                    <td>{pkg.reversible ? t('common.yes') : t('common.no')}</td>
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
