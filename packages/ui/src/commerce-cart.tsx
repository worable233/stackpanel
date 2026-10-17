'use client';

import { useActionState, useState, type ReactNode } from 'react';
import {
  ArrowRight,
  Check,
  CreditCard,
  LoaderCircle,
  Package,
  ShoppingCart,
  Trash2,
} from 'lucide-react';
import { Button } from './button.js';
import { Input } from './input.js';
import { Reveal } from './reveal.js';
import { Spotlight } from './spotlight.js';

export interface CommerceCartItem {
  id: string;
  name: string;
  quantity: number;
  stock: number;
  total: number;
  currency: string;
  available: boolean;
  summary?: string;
  productLink: ReactNode;
}
export interface CommerceCartPayment {
  id: string;
  label: string;
  action: (data: FormData) => Promise<void>;
  providerId?: string;
  paymentMethod?: string;
}
/**
 * All user-facing copy for the cart. `@stackpanel/ui` cannot read the host's
 * message catalogs, so the caller resolves these from its own catalog and
 * passes final strings in (ADR-0016 §6). Items in `{braces}` are already
 * interpolated by the caller.
 */
export interface CommerceCartLabels {
  selectAllAria: string;
  selectAll: string;
  productCount: string;
  selectItemAria: string;
  unavailable: string;
  outOfStock: string;
  stockLow: string;
  notCheckoutable: string;
  removeAria: string;
  updateAria: string;
  update: string;
  quantity: string;
  quantityValue: string;
  priceDisclaimer: string;
  summary: string;
  selectedItems: string;
  selectedCount: string;
  amountDue: string;
  pickProducts: string;
  paymentMethod: string;
  noPaymentMethods: string;
  submitting: string;
  checkout: string;
  mixedCurrencies: string;
  itemLimit: string;
  reviewHint: string;
}

export interface CommerceCartProps {
  items: CommerceCartItem[];
  payments: CommerceCartPayment[];
  updateQuantity?: (data: FormData) => Promise<void>;
  removeItem?: (data: FormData) => Promise<void>;
  continueShopping: ReactNode;
  /**
   * BCP 47 tag driving number/currency presentation (ADR-0016 §6). The host
   * supplies it — the primitive never guesses a locale or reads cookies.
   */
  locale?: string;
  /** Localized copy. See {@link CommerceCartLabels}. */
  labels: CommerceCartLabels;
}

function formatMoney(amount: number, currency: string, locale?: string) {
  if (!/^[A-Z]{3}$/.test(currency)) return `${(amount / 100).toFixed(2)} ${currency}`;
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount / 100);
}

function CartMutation({
  action,
  children,
  remove = false,
  label,
  updateLabel,
}: {
  action: (data: FormData) => Promise<void>;
  children: ReactNode;
  remove?: boolean;
  label: string;
  updateLabel: string;
}) {
  const [, submit, pending] = useActionState(async (_: null, data: FormData) => {
    await action(data);
    return null;
  }, null);
  return (
    <form action={submit} className="flex items-center gap-2">
      <fieldset disabled={pending} className="flex min-w-0 items-center gap-2">
        {children}
      </fieldset>
      <Button
        type="submit"
        variant="ghost"
        size={remove ? 'icon' : 'sm'}
        disabled={pending}
        aria-label={label}
      >
        {pending ? <LoaderCircle className="animate-spin" /> : remove ? <Trash2 /> : updateLabel}
      </Button>
    </form>
  );
}

/** Shared storefront presentation; the owning plugin supplies all data and actions. */
export function CommerceCart({
  items,
  payments,
  updateQuantity,
  removeItem,
  continueShopping,
  locale,
  labels,
}: CommerceCartProps) {
  const eligible = items.filter((item) => item.available && item.stock >= item.quantity);
  const [checked, setChecked] = useState(() => eligible.slice(0, 50).map((item) => item.id));
  const [paymentId, setPaymentId] = useState(payments[0]?.id ?? '');
  const selected = eligible.filter((item) => checked.includes(item.id));
  const payment = payments.find((option) => option.id === paymentId) ?? payments[0];
  const totals = selected.reduce<Record<string, number>>((sum, item) => {
    sum[item.currency] = (sum[item.currency] ?? 0) + item.total;
    return sum;
  }, {});
  const [checkoutRevision, checkout, pending] = useActionState(
    async (revision: number, data: FormData) => {
      if (!payment || selected.length === 0 || Object.keys(totals).length > 1) return revision;
      await payment.action(data);
      return revision + 1;
    },
    0,
  );
  const allChecked =
    eligible.length > 0 && eligible.length <= 50 && selected.length === eligible.length;
  const toggle = (id: string) =>
    setChecked((current) => {
      const valid = eligible.filter((item) => current.includes(item.id)).map((item) => item.id);
      return valid.includes(id)
        ? valid.filter((value) => value !== id)
        : valid.length < 50
          ? [...valid, id]
          : valid;
    });
  return (
    <div className="mt-10 grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_23rem] lg:gap-10">
      <div className="flex min-w-0 flex-col gap-4">
        <Reveal className="flex flex-wrap items-center justify-between gap-4 border-b border-foreground/10 pb-5">
          <label className="flex cursor-pointer items-center gap-3 text-sm">
            <input
              type="checkbox"
              aria-label={labels.selectAllAria}
              checked={allChecked}
              disabled={pending || !eligible.length}
              onChange={() =>
                setChecked(allChecked ? [] : eligible.slice(0, 50).map((item) => item.id))
              }
              className="size-4 accent-primary"
            />
            {labels.selectAll}{' '}
            <span className="text-muted-foreground">
              {selected.length} / {items.length}
            </span>
          </label>
          <span className="text-sm text-muted-foreground">
            {labels.productCount.replace(/\{(\w+)\}/g, (m, k: string) =>
              k === 'count' ? String(items.length) : m,
            )}
          </span>
        </Reveal>
        {items.map((item) => {
          const available = item.available && item.stock >= item.quantity;
          return (
            <Reveal key={`${item.id}-${item.quantity}-${item.total}`}>
              <Spotlight>
                <article className="flex flex-col gap-6 bg-foreground/[0.025] p-5 backdrop-blur-xl sm:p-7">
                  <div className="flex items-start gap-4">
                    <input
                      type="checkbox"
                      aria-label={labels.selectItemAria.replace('{name}', item.name)}
                      checked={available && checked.includes(item.id)}
                      disabled={
                        !available ||
                        pending ||
                        (!checked.includes(item.id) && selected.length >= 50)
                      }
                      onChange={() => toggle(item.id)}
                      className="mt-4 size-4 shrink-0 accent-primary"
                    />
                    <span
                      aria-hidden
                      className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary"
                    >
                      <Package className="size-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <h2 className="break-words text-base font-medium sm:text-lg">
                        {item.productLink}
                      </h2>
                      {item.summary ? (
                        <p className="mt-2 break-words text-sm leading-6 text-muted-foreground">
                          {item.summary}
                        </p>
                      ) : null}
                      {!available ? (
                        <p className="mt-2 text-xs text-destructive">
                          {!item.available
                            ? labels.unavailable
                            : item.stock === 0
                              ? labels.outOfStock
                              : labels.stockLow.replace('{count}', String(item.stock))}
                          {labels.notCheckoutable}
                        </p>
                      ) : null}
                    </div>
                    {removeItem ? (
                      <CartMutation
                        action={removeItem}
                        remove
                        label={labels.removeAria.replace('{name}', item.name)}
                        updateLabel={labels.update}
                      >
                        <input type="hidden" name="id" value={item.id} />
                      </CartMutation>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-4 border-t border-foreground/10 pt-5 sm:pl-8">
                    {updateQuantity && item.available && item.stock > 0 ? (
                      <CartMutation
                        action={updateQuantity}
                        label={labels.updateAria.replace('{name}', item.name)}
                        updateLabel={labels.update}
                      >
                        <input type="hidden" name="id" value={item.id} />
                        <label
                          htmlFor={`cart-quantity-${item.id}`}
                          className="shrink-0 text-xs whitespace-nowrap text-muted-foreground"
                        >
                          {labels.quantity}
                        </label>
                        <Input
                          id={`cart-quantity-${item.id}`}
                          name="quantity"
                          type="number"
                          min={1}
                          max={Math.min(item.stock, 100)}
                          defaultValue={item.quantity}
                          className="w-16 text-center"
                        />
                      </CartMutation>
                    ) : (
                      <span className="text-sm text-muted-foreground">
                        {labels.quantityValue.replace('{count}', String(item.quantity))}
                      </span>
                    )}
                    <span className="text-lg font-medium tabular-nums">
                      {formatMoney(item.total, item.currency, locale)}
                    </span>
                  </div>
                </article>
              </Spotlight>
            </Reveal>
          );
        })}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
          {continueShopping}
          <span>{labels.priceDisclaimer}</span>
        </div>
      </div>
      <aside className="lg:sticky lg:top-24">
        <Reveal>
          <Spotlight>
            <form
              action={checkout}
              className="relative flex flex-col gap-6 bg-foreground/[0.035] p-6 backdrop-blur-xl sm:p-7"
            >
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 -z-10 rounded-xl [background:radial-gradient(ellipse_at_top,color-mix(in_oklch,var(--primary)_9%,transparent),transparent_65%)]"
              />
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-xl font-medium">{labels.summary}</h2>
                <ShoppingCart className="size-5 text-muted-foreground" />
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{labels.selectedItems}</span>
                <span>{labels.selectedCount.replace('{count}', String(selected.length))}</span>
              </div>
              <div className="flex flex-col gap-3 border-y border-foreground/10 py-6">
                <p className="text-xs text-muted-foreground">{labels.amountDue}</p>
                {Object.keys(totals).length ? (
                  Object.entries(totals).map(([currency, total]) => (
                    <p
                      key={currency}
                      className="text-4xl font-semibold tracking-tight tabular-nums"
                    >
                      {formatMoney(total, currency, locale)}
                    </p>
                  ))
                ) : (
                  <p className="text-xl text-muted-foreground">{labels.pickProducts}</p>
                )}
              </div>
              {selected.map((item) => (
                <input key={item.id} type="hidden" name="cartItemIds" value={item.id} />
              ))}
              {payment?.providerId ? (
                <input type="hidden" name="providerId" value={payment.providerId} />
              ) : null}
              {payment?.paymentMethod ? (
                <input type="hidden" name="paymentMethod" value={payment.paymentMethod} />
              ) : null}
              <fieldset disabled={pending} className="flex min-w-0 flex-col gap-3">
                <legend className="mb-3 text-sm font-medium">{labels.paymentMethod}</legend>
                {payments.map((option) => (
                  <label
                    key={`${option.id}-${checkoutRevision}`}
                    className="flex cursor-pointer items-center gap-3 rounded-lg border border-foreground/10 bg-background/40 px-4 py-3 text-sm transition-colors hover:bg-primary/5 has-checked:border-primary/40 has-checked:bg-primary/10"
                  >
                    <input
                      type="radio"
                      name="paymentChoice"
                      value={option.id}
                      checked={payment?.id === option.id}
                      onChange={() => setPaymentId(option.id)}
                      className="size-4 shrink-0 accent-primary"
                    />
                    <CreditCard aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    <span className="flex-1">{option.label}</span>
                    {payment?.id === option.id ? (
                      <Check aria-hidden className="size-4 text-primary" />
                    ) : null}
                  </label>
                ))}
                {!payments.length ? (
                  <p className="text-sm leading-6 text-muted-foreground">
                    {labels.noPaymentMethods}
                  </p>
                ) : null}
              </fieldset>
              <Button
                type="submit"
                size="lg"
                disabled={pending || !payment || !selected.length || Object.keys(totals).length > 1}
                className="h-12 w-full"
              >
                {pending ? (
                  <LoaderCircle className="animate-spin" data-icon="inline-start" />
                ) : null}
                {pending ? labels.submitting : labels.checkout}
                {!pending ? <ArrowRight data-icon="inline-end" /> : null}
              </Button>
              <p className="text-xs leading-6 text-muted-foreground">
                {Object.keys(totals).length > 1
                  ? labels.mixedCurrencies
                  : selected.length >= 50
                    ? labels.itemLimit
                    : labels.reviewHint}
              </p>
            </form>
          </Spotlight>
        </Reveal>
      </aside>
    </div>
  );
}
