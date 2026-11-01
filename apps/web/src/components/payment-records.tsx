'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, ReceiptText, X } from 'lucide-react';
import type { AdminPaymentRecord } from '@stackpanel/sdk';
import { Badge, List, ListEmpty, ListItem, StatusBadge, type StatusTone } from '@stackpanel/ui';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useLocale, useTranslator } from '@/i18n/provider';
import { formatDateTime, formatMoney } from '@/i18n/core';
import {
  cancelAdminPaymentAction,
  confirmAdminPaymentAction,
  type AdminPaymentActionState,
} from '@/lib/admin-payment-actions';

/**
 * Operator view of payment records.
 *
 * For a gateway payment this page is read-only bookkeeping. For a manual
 * provider (bank transfer / QR) it is the *only* way money can ever be marked as
 * received: the buyer got no `paymentUrl`, so nothing will call back. Confirming
 * here unlocks the order and lets fulfilment start, which is why the action is
 * stated in plain words ("已收到款") instead of an abstract "settle".
 */
const STATUS_LABEL_KEYS: Record<string, string> = {
  PENDING: 'adminPayments.statusPending',
  PAID: 'adminPayments.statusPaid',
  REVIEW: 'adminPayments.statusReview',
  CANCELLED: 'adminPayments.statusCancelled',
  EXPIRED: 'adminPayments.statusExpired',
  REFUNDED: 'adminPayments.statusRefunded',
};

const STATUS_TONES: Record<string, StatusTone> = {
  PENDING: 'warn',
  PAID: 'ok',
  REVIEW: 'warn',
  CANCELLED: 'neutral',
  EXPIRED: 'neutral',
  REFUNDED: 'neutral',
  FAILED: 'error',
};

const METHOD_KEYS: Record<string, string> = {
  bank_transfer: 'adminPayments.methodBankTransfer',
  qrcode: 'adminPayments.methodQrCode',
  qr_code: 'adminPayments.methodQrCode',
  alipay: 'adminPayments.methodAlipay',
  wxpay: 'adminPayments.methodWechat',
  wechat: 'adminPayments.methodWechat',
  wechat_pay: 'adminPayments.methodWechat',
  wallet: 'adminPayments.methodWallet',
  stripe: 'adminPayments.methodStripe',
  paypal: 'adminPayments.methodPaypal',
};

export function PaymentRecords({ payments }: { payments: AdminPaymentRecord[] }) {
  const t = useTranslator();
  const locale = useLocale();
  const router = useRouter();
  const [isMutating, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  // 「已超时」必须随时间自己变。渲染期直接读 `Date.now()` 会让渲染不纯
  // （每次渲染结果不同，React 无法安全地跳过或重放），改为挂载取一次、
  // 之后每 30 秒由定时器回调刷新。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  function run(
    paymentId: string,
    work: () => Promise<AdminPaymentActionState>,
    fallback: { success: string; failure: string },
  ) {
    setBusyId(paymentId);
    startTransition(async () => {
      const result = await work();
      setBusyId(null);
      if (result.ok) {
        toast.success(result.message ?? fallback.success);
        router.refresh();
      } else {
        toast.error(result.error ?? fallback.failure);
      }
    });
  }

  if (payments.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl bg-muted/25 px-6 py-14 text-center">
        <span className="flex size-11 items-center justify-center rounded-2xl bg-background text-muted-foreground">
          <ReceiptText className="size-5" aria-hidden="true" />
        </span>
        <p className="mt-4 text-sm font-medium text-foreground">{t('adminPayments.empty')}</p>
        <p className="mt-1 max-w-xs text-xs text-muted-foreground">
          {t('adminPayments.emptyHint')}
        </p>
      </div>
    );
  }

  return (
    <List>
      {payments.map((payment) => {
        const canSettle = payment.status === 'PENDING' && payment.providerMode === 'manual';
        // The sweeper that flips PENDING → EXPIRED is best-effort: it needs a
        // scheduler, and in a single-node dev stack without Redis it simply
        // does not run. "Pending" alone would therefore lie to the operator,
        // so the deadline is shown for what it is — still settleable, but late.
        const overdue =
          payment.status === 'PENDING' &&
          payment.expiresAt !== null &&
          new Date(payment.expiresAt).getTime() < now;
        const amount = payment.orderAmount ?? payment.amount;
        const currency = payment.orderCurrency ?? payment.currency;
        const differs = currency !== payment.currency || amount !== payment.amount;
        const methodKey = payment.paymentMethod
          ? METHOD_KEYS[payment.paymentMethod.toLowerCase()]
          : undefined;
        const methodLabel =
          payment.methodName ??
          (methodKey
            ? t(methodKey)
            : payment.paymentMethod
              ? payment.paymentMethod.replace(/[_-]+/g, ' ')
              : '—');
        const statusLabel = t(STATUS_LABEL_KEYS[payment.status] ?? 'adminPayments.statusUnknown');
        return (
          <ListItem key={payment.id} className="flex flex-col gap-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs font-medium text-foreground">
                    #{payment.id.slice(-8).toUpperCase()}
                  </span>
                  <Badge>
                    {payment.purpose === 'TOP_UP'
                      ? t('adminPayments.purposeTopUp')
                      : t('adminPayments.purposeOrder')}
                  </Badge>
                  {payment.orderId ? (
                    <span className="text-xs text-muted-foreground">
                      {t('adminPayments.orderRef', {
                        id: payment.orderId.slice(-8).toUpperCase(),
                      })}
                    </span>
                  ) : null}
                </div>
                <span
                  className="max-w-70 truncate text-sm text-foreground"
                  title={payment.buyerEmail ?? undefined}
                >
                  {payment.buyerEmail ?? t('adminPayments.buyerUnknown')}
                </span>
              </div>
              <div className="shrink-0 text-right">
                <span className="block text-base font-semibold tabular-nums text-foreground">
                  {formatMoney(amount, currency, locale)}
                </span>
                {differs ? (
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">
                    {t('adminPayments.settlement', {
                      amount: formatMoney(payment.amount, payment.currency, locale),
                    })}
                  </span>
                ) : null}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="min-w-0">
                {methodLabel} ·{' '}
                {payment.providerMode === 'manual'
                  ? t('adminPayments.modeManual')
                  : payment.providerMode === 'gateway'
                    ? t('adminPayments.modeGateway')
                    : '—'}{' '}
                · {formatDateTime(new Date(payment.createdAt), locale)}
              </span>
              <div className="flex flex-wrap items-center justify-end gap-2">
                {overdue ? (
                  <span className="text-[11px] text-warning">{t('adminPayments.expiredHint')}</span>
                ) : null}
                <StatusBadge tone={STATUS_TONES[payment.status] ?? 'neutral'}>
                  {statusLabel}
                </StatusBadge>
                {canSettle ? (
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      disabled={isMutating && busyId === payment.id}
                      onClick={() =>
                        run(payment.id, () => confirmAdminPaymentAction(payment.id), {
                          success: t('adminPayments.confirmed'),
                          failure: t('adminPayments.confirmFailed'),
                        })
                      }
                    >
                      <Check aria-hidden="true" />
                      {t('adminPayments.confirm')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="px-2 text-muted-foreground hover:text-destructive"
                      disabled={isMutating && busyId === payment.id}
                      onClick={() =>
                        run(payment.id, () => cancelAdminPaymentAction(payment.id), {
                          success: t('adminPayments.cancelled'),
                          failure: t('adminPayments.cancelFailed'),
                        })
                      }
                    >
                      <X aria-hidden="true" />
                      {t('adminPayments.cancel')}
                    </Button>
                  </div>
                ) : null}
              </div>
            </div>
          </ListItem>
        );
      })}
    </List>
  );
}
