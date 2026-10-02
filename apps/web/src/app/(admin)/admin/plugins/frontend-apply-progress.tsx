'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { FrontendApplyStatus } from '@stackpanel/sdk';
import { Progress } from '@/components/ui/progress';
import { getFrontendApplyStatusAction } from '@/lib/plugin-actions';
import { useTranslator } from '@/i18n/provider';
import type { Translator } from '@/i18n/core';

const POLL_MS = 2000;

/** Whether the apply is still running (so callers keep polling). */
export function isFrontendApplyActive(status: FrontendApplyStatus | null): boolean {
  return (
    !!status &&
    (status.state === 'pending' || status.state === 'building' || status.state === 'restarting')
  );
}

/**
 * Polls the web tier's frontend apply status while one is in flight, and
 * refreshes the route once it settles. `requestedAt` optionally pins the poll
 * to one specific apply (e.g. the upload the caller just triggered).
 */
export function useFrontendApplyStatus(
  initial: FrontendApplyStatus | null,
  options?: { requestedAt?: string | null; enabled?: boolean },
): FrontendApplyStatus | null {
  const router = useRouter();
  const enabled = options?.enabled ?? true;
  const [status, setStatus] = useState<FrontendApplyStatus | null>(initial);

  useEffect(() => {
    if (!enabled) return;
    // "Pinned" means a specific request was named but the polled status is not
    // it yet (e.g. right after an upload, before the worker picks it up).
    const pendingRequest =
      Boolean(options?.requestedAt) && status?.requestedAt !== options?.requestedAt;
    if (!isFrontendApplyActive(status) && !pendingRequest) return;
    let cancelled = false;
    const poll = async () => {
      const next = await getFrontendApplyStatusAction();
      if (cancelled) return;
      // `null` means the status is unreadable right now — typically because the
      // web server is being restarted mid-apply. Keep the last known status so
      // the progress bar stays visible, and keep polling.
      if (!next) return;
      if (options?.requestedAt && next.requestedAt !== options.requestedAt) return;
      setStatus(next);
      if (!isFrontendApplyActive(next)) router.refresh();
    };
    // Poll immediately so the UI reacts as soon as work starts, then on a timer.
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, status, router, options?.requestedAt]);

  return status;
}

/** Overall completion for the progress bar; can only move forward per apply. */
function progressValue(status: FrontendApplyStatus): number {
  if (status.state === 'succeeded' || status.state === 'failed') return 100;
  const total = status.steps?.length ?? 4;
  const step = Math.min(Math.max(status.step ?? 1, 1), total);
  return Math.max(Math.round(((step - 1) / total) * 100), 8);
}

function title(status: FrontendApplyStatus, t: Translator): string {
  const label = status.label ? t('apply.labeled', { label: status.label }) : '';
  const noun = status.target === 'theme' ? t('apply.noun.theme') : t('apply.noun.plugin');
  const nounCap = status.target === 'theme' ? t('apply.nounCap.theme') : t('apply.nounCap.plugin');
  const action = status.action === 'remove' ? 'remove' : status.action === 'update' ? 'update' : 'install';
  const params = { noun, nounCap, label };
  if (status.state === 'failed') return t(`apply.${action}.failed`, params);
  if (status.state === 'succeeded') return t(`apply.${action}.succeeded`, params);
  return t(`apply.${action}.inProgress`, params);
}

/**
 * Progress card for an in-flight (or just-finished) frontend apply. Shows a bar,
 * the ordered steps, and what is happening right now.
 */
export function FrontendApplyProgress({ status }: { status: FrontendApplyStatus }) {
  const t = useTranslator();
  const percent = progressValue(status);
  const active = isFrontendApplyActive(status);
  const failed = status.state === 'failed';
  const step = status.step ?? 1;
  const detail =
    status.detail ??
    (status.state === 'pending'
      ? t('apply.queued')
      : failed
        ? (status.message ?? t('apply.applyFailed'))
        : t('apply.processing'));

  return (
    <div
      className="rounded-lg border bg-card p-4 text-card-foreground"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">{title(status, t)}</p>
        <span className="text-xs tabular-nums text-muted-foreground">{percent}%</span>
      </div>

      <Progress
        className="mt-3"
        value={percent}
        indicatorClassName={
          failed
            ? 'bg-destructive'
            : status.state === 'succeeded'
              ? 'bg-emerald-500'
              : active
                ? 'bg-primary animate-pulse'
                : undefined
        }
      />

      {status.steps && status.steps.length > 0 ? (
        <ol className="mt-3 grid gap-1 text-xs text-muted-foreground">
          {status.steps.map((name, index) => {
            const position = index + 1;
            const done = status.state === 'succeeded' || position < step;
            const current = active && position === step;
            return (
              <li key={name} className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={
                    'inline-block size-1.5 shrink-0 rounded-full ' +
                    (failed && current
                      ? 'bg-destructive'
                      : done
                        ? 'bg-emerald-500'
                        : current
                          ? 'bg-primary'
                          : 'bg-border')
                  }
                />
                <span className={current ? 'text-foreground' : undefined}>
                  {position}. {name}
                  {current ? `（${detail}）` : ''}
                </span>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">{detail}</p>
      )}

      {failed && status.message ? (
        <p className="mt-3 text-xs text-destructive">{status.message}</p>
      ) : null}
    </div>
  );
}
