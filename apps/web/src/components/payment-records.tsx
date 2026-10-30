'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, ReceiptText, X } from 'lucide-react';
import type { AdminPaymentRecord } from '@stackpanel/sdk';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useLocale, useTranslator } from '@/i18n/provider';
import { formatDateTime, formatMoney } from '@/i18n/core';
import { cn } from '@/lib/utils';
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

const STATUS_TONES: Record<string, string> = {
  PENDING: 'bg-warning/10 text-warning',
  PAID: 'bg-success/10 text-success',
  REVIEW: 'bg-muted text-foreground',
  CANCELLED: 'bg-destructive/10 text-destructive',
  EXPIRED: 'bg-muted text-muted-foreground',
  REFUNDED: 'bg-muted text-muted-foreground',
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
      <div className="flex flex-col items-center justify-center rounded-2xl bg-muted/30 px-6 py-14 text-center">
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
    <Table className="min-w-[960px]">
        <TableHeader className="[&_tr]:border-0">
          <TableRow className="border-0 hover:bg-transparent">
            <TableHead className="h-9 px-3 text-xs font-medium text-muted-foreground">
              {t('adminPayments.colPayment')}
            </TableHead>
            <TableHead className="h-9 px-3 text-xs font-medium text-muted-foreground">
              {t('adminPayments.colBuyer')}
            </TableHead>
            <TableHead className="h-9 px-3 text-xs font-medium text-muted-foreground">
              {t('adminPayments.colPurpose')}
            </TableHead>
            <TableHead className="h-9 px-3 text-right text-xs font-medium text-muted-foreground">
              {t('adminPayments.colAmount')}
            </TableHead>
            <TableHead className="h-9 px-3 text-xs font-medium text-muted-foreground">
              {t('adminPayments.colMethod')}
            </TableHead>
            <TableHead className="h-9 px-3 text-xs font-medium text-muted-foreground">
              {t('adminPayments.colStatus')}
            </TableHead>
            <TableHead className="h-9 px-3 text-xs font-medium text-muted-foreground">
              {t('adminPayments.colCreatedAt')}
            </TableHead>
            <TableHead className="h-9 px-3 text-right text-xs font-medium text-muted-foreground">
              {t('adminPayments.colActions')}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {payments.map((payment) => {
            const canSettle = payment.status === 'PENDING' && payment.providerMode === 'manual';
            // The sweeper that flips PENDING → EXPIRED is best-effort: it needs a
            // scheduler, and in a single-node dev stack without Redis it simply
            // does not run. "Pending" alone would therefore lie to the operator,
            // so the deadline is shown for what it is — still settleable, but
            // late.
            const overdue =
              payment.status === 'PENDING' &&
              payment.expiresAt !== null &&
              new Date(payment.expiresAt).getTime() < Date.now();
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
            const statusLabel = t(
              STATUS_LABEL_KEYS[payment.status] ?? 'adminPayments.statusUnknown',
            );
            return (
              <TableRow
                key={payment.id}
                className="border-0 odd:bg-muted/20 hover:bg-muted/40"
              >
                <TableCell className="px-3 py-3.5">
                  <span className="block font-mono text-xs font-medium text-foreground">
                    #{payment.id.slice(-8).toUpperCase()}
                  </span>
                  {payment.orderId ? (
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">
                      {t('adminPayments.orderRef', {
                        id: payment.orderId.slice(-8).toUpperCase(),
                      })}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="max-w-52 px-3 py-3.5">
                  <span
                    className="block truncate text-sm text-foreground"
                    title={payment.buyerEmail ?? undefined}
                  >
                    {payment.buyerEmail ?? t('adminPayments.buyerUnknown')}
                  </span>
                </TableCell>
                <TableCell className="px-3 py-3.5 text-sm text-muted-foreground">
                  {payment.purpose === 'TOP_UP'
                    ? t('adminPayments.purposeTopUp')
                    : t('adminPayments.purposeOrder')}
                </TableCell>
                <TableCell className="px-3 py-3.5 text-right">
                  <span className="block text-sm font-medium tabular-nums text-foreground">
                    {formatMoney(amount, currency, locale)}
                  </span>
                  {differs ? (
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">
                      {t('adminPayments.settlement', {
                        amount: formatMoney(payment.amount, payment.currency, locale),
                      })}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="px-3 py-3.5">
                  <span className="block text-sm text-foreground">{methodLabel}</span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">
                    {payment.providerMode === 'manual'
                      ? t('adminPayments.modeManual')
                      : payment.providerMode === 'gateway'
                        ? t('adminPayments.modeGateway')
                        : '—'}
                  </span>
                </TableCell>
                <TableCell className="px-3 py-3.5">
                  <span
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
                      STATUS_TONES[payment.status] ?? 'bg-muted text-muted-foreground',
                    )}
                  >
                    {statusLabel}
                  </span>
                  {overdue ? (
                    <span className="mt-1 block text-[11px] text-warning">
                      {t('adminPayments.expiredHint')}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="px-3 py-3.5 text-xs text-muted-foreground">
                  {formatDateTime(new Date(payment.createdAt), locale)}
                </TableCell>
                <TableCell className="px-3 py-3.5 text-right">
                  {canSettle ? (
                    <div className="flex items-center justify-end gap-1">
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
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
  );
}
