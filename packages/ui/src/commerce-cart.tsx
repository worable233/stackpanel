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
}: {
  action: (data: FormData) => Promise<void>;
  children: ReactNode;
  remove?: boolean;
  label: string;
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
        {pending ? <LoaderCircle className="animate-spin" /> : remove ? <Trash2 /> : '更新'}
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
              aria-label="选择全部可购买商品"
              checked={allChecked}
              disabled={pending || !eligible.length}
              onChange={() =>
                setChecked(allChecked ? [] : eligible.slice(0, 50).map((item) => item.id))
              }
              className="size-4 accent-primary"
            />
            全选{' '}
            <span className="text-muted-foreground">
              {selected.length} / {items.length}
            </span>
          </label>
          <span className="text-sm text-muted-foreground">{items.length} 项云产品</span>
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
                      aria-label={`选择 ${item.name}`}
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
                            ? '商品已下架'
                            : item.stock === 0
                              ? '暂时缺货'
                              : `库存仅剩 ${item.stock} 件，请调整数量`}
                          ，暂时无法结算。
                        </p>
                      ) : null}
                    </div>
                    {removeItem ? (
                      <CartMutation action={removeItem} remove label={`移除 ${item.name}`}>
                        <input type="hidden" name="id" value={item.id} />
                      </CartMutation>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-4 border-t border-foreground/10 pt-5 sm:pl-8">
                    {updateQuantity && item.available && item.stock > 0 ? (
                      <CartMutation action={updateQuantity} label={`更新 ${item.name} 数量`}>
                        <input type="hidden" name="id" value={item.id} />
                        <label
                          htmlFor={`cart-quantity-${item.id}`}
                          className="shrink-0 text-xs whitespace-nowrap text-muted-foreground"
                        >
                          数量
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
                      <span className="text-sm text-muted-foreground">数量 × {item.quantity}</span>
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
          <span>价格以结算时确认为准</span>
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
                <h2 className="text-xl font-medium">订单摘要</h2>
                <ShoppingCart className="size-5 text-muted-foreground" />
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">已选商品</span>
                <span>{selected.length} 项</span>
              </div>
              <div className="flex flex-col gap-3 border-y border-foreground/10 py-6">
                <p className="text-xs text-muted-foreground">应付金额</p>
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
                  <p className="text-xl text-muted-foreground">请选择商品</p>
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
                <legend className="mb-3 text-sm font-medium">支付方式</legend>
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
                    暂无可用支付方式，请稍后再试。
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
                {pending ? '正在提交…' : '确认并结算'}
                {!pending ? <ArrowRight data-icon="inline-end" /> : null}
              </Button>
              <p className="text-xs leading-6 text-muted-foreground">
                {Object.keys(totals).length > 1
                  ? '不同币种的商品请分开结算。'
                  : selected.length >= 50
                    ? '每笔订单最多结算 50 项商品。'
                    : '提交前请核对商品配置与数量。'}
              </p>
            </form>
          </Spotlight>
        </Reveal>
      </aside>
    </div>
  );
}
