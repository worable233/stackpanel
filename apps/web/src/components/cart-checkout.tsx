'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Clock3,
  CreditCard,
  Loader2,
  Package,
} from 'lucide-react';
import { Button, Field, FieldGroup, InlineError, Select } from '@stackpanel/ui';
import { formatMinorCurrency, type FrontendActionExecutor } from '@stackpanel/sdk';
import { resolveLocale } from '@/i18n/config';
import { createTranslator } from '@/i18n/core';

export interface CartCheckoutProps {
  lines: Array<{
    id: string;
    name: string;
    quantity: number;
    total: number;
    summary?: string | undefined;
    available?: boolean;
    controls?: ReactNode;
  }>;
  currency: string;
  locale?: string | undefined;
  methods: Array<{ id: string; label: string; providerId?: string; paymentMethod?: string }>;
  wallet?: FrontendActionExecutor | undefined;
  external?: FrontendActionExecutor | undefined;
  labels: { items: string; total: string; payment: string; submit: string; unavailable: string };
  resultRequested?: boolean;
  result?:
    | { id: string; status: string; total: number; currency: string; paymentUrl?: string | null }
    | null
    | undefined;
}

export function CartCheckout(props: CartCheckoutProps) {
  const router = useRouter();
  const [selected, setSelected] = useState(
    props.lines.filter((line) => line.available !== false).map((line) => line.id),
  );
  const [methodId, setMethodId] = useState(props.methods[0]?.id ?? '');
  const [pending, setPending] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [step, setStep] = useState(1);
  const result = props.result;
  const paid = result?.status === 'PAID';
  const current = props.resultRequested ? (paid ? 3 : 2) : step;
  const method = props.methods.find((candidate) => candidate.id === methodId);
  const action = method?.providerId ? props.external : props.wallet;
  const lines = props.lines.filter(
    (line) => selected.includes(line.id) && line.available !== false,
  );
  const total = lines.reduce((sum, line) => sum + line.total, 0);
  const money = (amount: number, currency = props.currency) =>
    formatMinorCurrency(amount, currency, resolveLocale(props.locale));
  const locale = resolveLocale(props.locale);
  const t = createTranslator(locale);
  const c = {
    steps: [t('checkout.steps.review'), t('checkout.steps.pay'), t('checkout.steps.done')],
    next: t('checkout.next'),
    back: t('checkout.back'),
    review: t('checkout.review'),
    reviewHelp: t('checkout.reviewHelp'),
    pay: t('checkout.pay'),
    payHelp: t('checkout.payHelp'),
    selected: t('checkout.selected'),
    quantity: t('checkout.quantity'),
    success: t('checkout.success'),
    successHelp: t('checkout.successHelp'),
    orders: t('checkout.orders'),
    services: t('checkout.services'),
    waiting: t('checkout.waiting'),
    waitingHelp: t('checkout.waitingHelp'),
    failed: t('checkout.failed'),
    failedHelp: t('checkout.failedHelp'),
    unknown: t('checkout.unknown'),
    unknownHelp: t('checkout.unknownHelp'),
    refresh: t('checkout.refresh'),
    resume: t('checkout.resume'),
    submitting: t('checkout.submitting'),
    order: t('checkout.order'),
  };
  useEffect(() => {
    if (!props.resultRequested || result?.status !== 'PENDING') return;
    const timer = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(timer);
  }, [props.resultRequested, result?.id, result?.status, router]);

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <ol
        aria-label={t('checkout.progress')}
        className="grid grid-cols-3 border-b pb-6"
      >
        {c.steps.map((label, i) => (
          <li
            key={label}
            aria-current={current === i + 1 ? 'step' : undefined}
            className={`flex items-center gap-2 sm:gap-3 ${current >= i + 1 ? 'text-foreground' : 'text-muted-foreground'}`}
          >
            <span
              className={`flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold sm:size-9 ${current > i + 1 ? 'bg-primary text-primary-foreground' : current === i + 1 ? 'border-2 border-primary text-primary' : 'border bg-muted/30'}`}
            >
              {current > i + 1 ? <Check className="size-4" /> : `0${i + 1}`}
            </span>
            <span className="text-xs font-medium sm:text-sm">{label}</span>
          </li>
        ))}
      </ol>
      {props.resultRequested ? (
        <section
          className="mx-auto flex w-full max-w-xl flex-col items-center gap-5 py-8 text-center"
          aria-live="polite"
        >
          {paid ? (
            <CheckCircle2 className="size-12 text-success" />
          ) : (
            <Clock3 className="size-12 text-muted-foreground" />
          )}
          <h2 className="text-2xl font-semibold tracking-tight">
            {paid
              ? c.success
              : !result
                ? c.unknown
                : result.status === 'PENDING'
                  ? c.waiting
                  : c.failed}
          </h2>
          <p className="max-w-md text-sm leading-6 text-muted-foreground">
            {paid
              ? c.successHelp
              : !result
                ? c.unknownHelp
                : result.status === 'PENDING'
                  ? c.waitingHelp
                  : c.failedHelp}
          </p>
          {result ? (
            <dl className="w-full rounded-xl border bg-card p-5 text-sm">
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="text-muted-foreground">{c.order}</dt>
                <dd className="break-all font-mono text-xs">{result.id}</dd>
              </div>
              <div className="mt-4 flex justify-between">
                <dt className="text-muted-foreground">{props.labels.total}</dt>
                <dd className="font-semibold">{money(result.total, result.currency)}</dd>
              </div>
            </dl>
          ) : null}
          <div className="flex flex-wrap justify-center gap-3">
            {paid ? (
              <Button nativeButton={false} render={<Link href="/account/services" />}>
                {c.services}
                <ArrowRight data-icon="inline-end" />
              </Button>
            ) : (
              <Button type="button" onClick={() => router.refresh()}>
                {c.refresh}
              </Button>
            )}
            {result?.status === 'PENDING' &&
            result.paymentUrl &&
            /^https?:\/\//i.test(result.paymentUrl) ? (
              <Button nativeButton={false} render={<a href={result.paymentUrl} />}>
                {c.resume}
              </Button>
            ) : null}
            <Button variant="outline" nativeButton={false} render={<Link href="/account/orders" />}>
              {c.orders}
            </Button>
          </div>
        </section>
      ) : (
        <div className="grid min-w-0 items-start gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <section className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight">
              {current === 1 ? c.review : c.pay}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {current === 1 ? c.reviewHelp : c.payHelp}
            </p>
            {current === 1 ? (
              <ul className="mt-6 divide-y rounded-xl border bg-card">
                {props.lines.map((line) => (
                  <li key={line.id} className="flex min-w-0 gap-3 p-4 sm:gap-4 sm:p-5">
                    <input
                      type="checkbox"
                      aria-label={line.name}
                      checked={selected.includes(line.id)}
                      disabled={line.available === false || pending}
                      onChange={(event) =>
                        setSelected((previous) =>
                          event.target.checked
                            ? [...previous, line.id]
                            : previous.filter((id) => id !== line.id),
                        )
                      }
                      className="mt-1 size-4 shrink-0 accent-primary"
                    />
                    <Package className="mt-0.5 hidden size-5 shrink-0 text-muted-foreground sm:block" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap justify-between gap-3">
                        <h3 className="text-sm font-semibold">{line.name}</h3>
                        <span className="text-sm font-semibold tabular-nums">
                          {line.available === false ? '—' : money(line.total)}
                        </span>
                      </div>
                      {line.summary ? (
                        <dl className="mt-4 grid gap-x-5 gap-y-2 text-xs sm:grid-cols-2 xl:grid-cols-3">
                          {line.summary.split(' · ').map((part, i) => {
                            const split = part.indexOf(':');
                            return (
                              <div key={i} className="flex min-w-0 gap-2 leading-5">
                                <dt className="shrink-0 text-muted-foreground">
                                  {split >= 0 ? part.slice(0, split) : '—'}
                                </dt>
                                <dd className="min-w-0 break-words">
                                  {split >= 0 ? part.slice(split + 1) : part}
                                </dd>
                              </div>
                            );
                          })}
                        </dl>
                      ) : null}
                      <div className="mt-4 flex flex-wrap items-center gap-3 border-t pt-4">
                        {line.controls ?? (
                          <span className="text-xs text-muted-foreground">
                            {c.quantity} × {line.quantity}
                          </span>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="mt-6 flex flex-col gap-5 rounded-xl border bg-card p-5">
                <h3 className="flex items-center gap-2 text-sm font-medium">
                  <CreditCard className="size-4 text-muted-foreground" />
                  {props.labels.payment}
                </h3>
                {props.methods.length ? (
                  <FieldGroup>
                    <Field>
                      <label className="sr-only" htmlFor={`payment-${props.currency}`}>
                        {props.labels.payment}
                      </label>
                      <Select
                        id={`payment-${props.currency}`}
                        value={methodId}
                        disabled={pending}
                        onChange={(event) => setMethodId(event.target.value)}
                      >
                        {props.methods.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </FieldGroup>
                ) : (
                  <InlineError>{props.labels.unavailable}</InlineError>
                )}
                <ul className="divide-y border-t">
                  {lines.map((line) => (
                    <li key={line.id} className="flex justify-between gap-4 py-4 text-sm">
                      <span>
                        {line.name}
                        <span className="ml-2 text-muted-foreground">× {line.quantity}</span>
                      </span>
                      <span className="shrink-0 tabular-nums">{money(line.total)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
          <aside className="flex flex-col gap-5 rounded-xl border bg-card p-5 lg:sticky lg:top-24">
            <h2 className="text-sm font-medium">
              {c.selected}
              <span className="ml-2 text-muted-foreground">{lines.length}</span>
            </h2>
            <dl className="flex items-baseline justify-between border-t pt-5">
              <dt className="text-sm text-muted-foreground">{props.labels.total}</dt>
              <dd className="text-3xl font-semibold tracking-tight tabular-nums">{money(total)}</dd>
            </dl>
            {current === 1 ? (
              <Button type="button" disabled={!lines.length} onClick={() => setStep(2)}>
                {c.next}
                <ArrowRight data-icon="inline-end" />
              </Button>
            ) : (
              <>
                <form
                  action={async (data) => {
                    setSubmitError(null);
                    try {
                      if (action) await action(data);
                    } catch {
                      // Keep the buyer on the payment step with a localised,
                      // actionable message instead of failing silently.
                      setSubmitError(c.failedHelp);
                    } finally {
                      setPending(false);
                    }
                  }}
                  onSubmit={(event) => {
                    if (pending || !action || !method || !lines.length) {
                      event.preventDefault();
                      return;
                    }
                    setPending(true);
                  }}
                >
                  {lines.map((line) => (
                    <input key={line.id} type="hidden" name="cartItemIds" value={line.id} />
                  ))}
                  {method?.providerId ? (
                    <>
                      <input type="hidden" name="providerId" value={method.providerId} />
                      <input type="hidden" name="paymentMethod" value={method.paymentMethod} />
                    </>
                  ) : null}
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={pending || !lines.length || !action || !method}
                  >
                    {pending ? (
                      <>
                        <Loader2 className="animate-spin" data-icon="inline-start" />
                        {c.submitting}
                      </>
                    ) : (
                      props.labels.submit
                    )}
                  </Button>
                  {submitError ? (
                    <InlineError>{submitError}</InlineError>
                  ) : null}
                </form>
                <Button type="button" variant="ghost" disabled={pending} onClick={() => setStep(1)}>
                  <ArrowLeft data-icon="inline-start" />
                  {c.back}
                </Button>
              </>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
