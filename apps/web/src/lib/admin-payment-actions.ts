'use server';

import { revalidatePath } from 'next/cache';
import { getLocale } from '@/i18n/locale';
import { translate } from '@/i18n/core';
import { getAuthedApiClient } from './api';
import { apiErrorMessage } from './api-errors';

export interface AdminPaymentActionState {
  error?: string;
  ok?: boolean;
  message?: string;
}

/**
 * Why a manual confirmation can be refused, in operator language.
 *
 * The kernel deliberately answers 409 with a machine reason rather than a
 * message, because the same call is made from HTTP clients. Translating here
 * keeps the reason table next to the UI that shows it.
 */
const REASON_KEYS: Record<string, string> = {
  NOT_FOUND: 'adminPayments.reason.notFound',
  NOT_MANUAL: 'adminPayments.reason.notManual',
  NOT_PENDING: 'adminPayments.reason.notPending',
};

/** Confirm a manual payment as received (settles the linked order). */
export async function confirmAdminPaymentAction(
  paymentId: string,
): Promise<AdminPaymentActionState> {
  const locale = await getLocale();
  try {
    const api = await getAuthedApiClient();
    const result = await api.confirmAdminPayment(paymentId);
    if (!result.confirmed) {
      return {
        error: translate(locale, REASON_KEYS[result.reason] ?? 'adminPayments.confirmFailed'),
      };
    }
    revalidatePath('/admin/payments');
    return { ok: true, message: translate(locale, 'adminPayments.confirmed') };
  } catch (error) {
    return {
      error: await apiErrorMessage(error, translate(locale, 'adminPayments.confirmFailed')),
    };
  }
}

/** Cancel a manual payment that will never be paid (releases the order). */
export async function cancelAdminPaymentAction(
  paymentId: string,
): Promise<AdminPaymentActionState> {
  const locale = await getLocale();
  try {
    const api = await getAuthedApiClient();
    const result = await api.cancelAdminPayment(paymentId);
    if (!result.cancelled) {
      return {
        error: translate(locale, REASON_KEYS[result.reason] ?? 'adminPayments.cancelFailed'),
      };
    }
    revalidatePath('/admin/payments');
    return { ok: true, message: translate(locale, 'adminPayments.cancelled') };
  } catch (error) {
    return {
      error: await apiErrorMessage(error, translate(locale, 'adminPayments.cancelFailed')),
    };
  }
}
