'use server';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getLocale } from '@/i18n/locale';
import { translate } from '@/i18n/core';
import { getAuthedApiClient } from './api';
import { apiErrorMessage } from './api-errors';

export interface UserActionResult {
  error?: string;
  ok?: boolean;
  message?: string;
}

export interface CreateUserResult extends UserActionResult {
  /** One-time generated password when none was supplied by the admin. */
  generatedPassword?: string;
}

function revalidateUser(userId: string): void {
  revalidatePath(`/admin/users/${userId}`);
  revalidatePath('/admin/users');
}

/** Create a new user (password optional; server generates one when omitted). */
export async function createUserAction(input: {
  email: string;
  password?: string;
  status?: 'ACTIVE' | 'DISABLED';
  groupIds?: string[];
}): Promise<CreateUserResult> {
  const locale = await getLocale();
  if (!input.email?.trim()) return { error: translate(locale, 'user.emailRequired') };
  try {
    const api = await getAuthedApiClient();
    const result = await api.createAdminUser({
      email: input.email.trim().toLowerCase(),
      ...(input.password ? { password: input.password } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.groupIds ? { groupIds: input.groupIds } : {}),
    });
    revalidatePath('/admin/users');
    return {
      ok: true,
      message: translate(locale, 'user.created', { email: result.user.email }),
      ...(result.generatedPassword ? { generatedPassword: result.generatedPassword } : {}),
    };
  } catch (error) {
    return { error: await apiErrorMessage(error, translate(locale, 'user.createFailed')) };
  }
}

/** Toggle a user's active/disabled status. */
export async function updateUserStatusAction(
  userId: string,
  status: 'ACTIVE' | 'DISABLED',
): Promise<UserActionResult> {
  const locale = await getLocale();
  try {
    const api = await getAuthedApiClient();
    await api.updateAdminUser(userId, { status });
    revalidateUser(userId);
    return { ok: true, message: translate(locale, 'user.statusUpdated') };
  } catch (error) {
    return { error: await apiErrorMessage(error, translate(locale, 'user.statusUpdateFailed')) };
  }
}

/** Replace a user's permission-group memberships. */
export async function updateUserGroupsAction(
  userId: string,
  groupIds: string[],
): Promise<UserActionResult> {
  const locale = await getLocale();
  if (groupIds.length === 0) return { error: translate(locale, 'user.atLeastOneGroup') };
  try {
    const api = await getAuthedApiClient();
    await api.updateAdminUser(userId, { groupIds });
    revalidateUser(userId);
    return { ok: true, message: translate(locale, 'user.groupsUpdated') };
  } catch (error) {
    return { error: await apiErrorMessage(error, translate(locale, 'user.groupsUpdateFailed')) };
  }
}

/** Adjust a user's wallet balance (positive or negative). */
export async function adjustUserWalletAction(
  userId: string,
  amount: number,
  note: string,
): Promise<UserActionResult> {
  const locale = await getLocale();
  if (!Number.isFinite(amount) || amount === 0) {
    return { error: translate(locale, 'user.amountRequired') };
  }
  try {
    const api = await getAuthedApiClient();
    await api.adjustUserWallet(userId, {
      amount: Math.round(amount),
      note: note.trim() || translate(locale, 'user.adminAdjustment'),
    });
    revalidateUser(userId);
    return { ok: true, message: translate(locale, 'user.balanceAdjusted') };
  } catch (error) {
    return { error: await apiErrorMessage(error, translate(locale, 'user.balanceAdjustFailed')) };
  }
}

/** Gift a service (product) to the user. */
export async function giftServiceAction(
  userId: string,
  input: { productId: string; quantity?: number; expiresAt?: string },
): Promise<UserActionResult> {
  const locale = await getLocale();
  if (!input.productId) return { error: translate(locale, 'user.productRequired') };
  try {
    const api = await getAuthedApiClient();
    await api.giftUserService(userId, {
      productId: input.productId,
      ...(input.quantity ? { quantity: input.quantity } : {}),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    });
    revalidateUser(userId);
    return { ok: true, message: translate(locale, 'user.serviceGifted') };
  } catch (error) {
    return { error: await apiErrorMessage(error, translate(locale, 'user.giftFailed')) };
  }
}

/** Update a user's service (expiry time / status). */
export async function updateServiceAction(
  userId: string,
  serviceId: string,
  patch: { expiresAt?: string | null; status?: string },
): Promise<UserActionResult> {
  const locale = await getLocale();
  try {
    const api = await getAuthedApiClient();
    await api.updateAdminUserService(userId, serviceId, {
      ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    });
    revalidateUser(userId);
    return { ok: true, message: translate(locale, 'user.serviceUpdated') };
  } catch (error) {
    return { error: await apiErrorMessage(error, translate(locale, 'user.serviceUpdateFailed')) };
  }
}

/** Delete a user's service. */
export async function deleteServiceAction(
  userId: string,
  serviceId: string,
): Promise<UserActionResult> {
  const locale = await getLocale();
  try {
    const api = await getAuthedApiClient();
    await api.deleteAdminUserService(userId, serviceId);
    revalidateUser(userId);
    return { ok: true, message: translate(locale, 'user.serviceDeleted') };
  } catch (error) {
    return { error: await apiErrorMessage(error, translate(locale, 'user.serviceDeleteFailed')) };
  }
}

/** Sign in as the target user and land on their account backend. */
export async function impersonateUserAction(userId: string): Promise<never> {
  const api = await getAuthedApiClient();
  const result = await api.impersonateUser(userId);
  const store = await cookies();
  store.set(process.env.SESSION_COOKIE_NAME ?? 'sp_session', result.token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: Number(process.env.SESSION_TTL_SECONDS ?? 43200),
  });
  redirect('/account');
}
