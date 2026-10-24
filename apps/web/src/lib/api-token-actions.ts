'use server';
import { revalidatePath } from 'next/cache';
import { getLocale } from '@/i18n/locale';
import { translate } from '@/i18n/core';
import { getAuthedApiClient } from './api';
import { apiErrorMessage } from './api-errors';

/** Server actions for the account-center API token settings (session stays server-side). */

export interface ApiTokenActionResult {
  error?: string;
  ok?: boolean;
}

export interface CreateApiTokenResult extends ApiTokenActionResult {
  /** Plaintext secret, returned exactly once by the API. */
  token?: string;
  id?: string;
}

export async function createApiTokenAction(input: {
  name: string;
  scopes: string[];
  /** 可选的 Ed25519 公钥（PEM）；非空则该密钥的请求必须带签名。 */
  publicKey?: string | null;
}): Promise<CreateApiTokenResult> {
  const locale = await getLocale();
  if (!input.name?.trim()) return { error: translate(locale, 'action.apiTokenNameRequired') };
  try {
    const api = await getAuthedApiClient();
    const result = await api.createApiToken({
      name: input.name.trim(),
      scopes: input.scopes,
      ...(input.publicKey ? { publicKey: input.publicKey } : {}),
    });
    revalidatePath('/account/settings');
    return { ok: true, token: result.token, id: result.apiToken.id };
  } catch (error) {
    return {
      error: await apiErrorMessage(error, translate(locale, 'action.apiTokenCreateFailed')),
    };
  }
}

export async function revokeApiTokenAction(id: string): Promise<ApiTokenActionResult> {
  const locale = await getLocale();
  if (!id) return { error: translate(locale, 'action.apiTokenIdRequired') };
  try {
    const api = await getAuthedApiClient();
    await api.revokeApiToken(id);
    revalidatePath('/account/settings');
    return { ok: true };
  } catch (error) {
    return {
      error: await apiErrorMessage(error, translate(locale, 'action.apiTokenRevokeFailed')),
    };
  }
}

export async function updateApiTokenAction(
  id: string,
  input: {
    name?: string;
    scopes?: string[];
    status?: 'ACTIVE' | 'DISABLED';
    /** `null` = 清除公钥（退回只凭 Bearer）。 */
    publicKey?: string | null;
  },
): Promise<ApiTokenActionResult> {
  const locale = await getLocale();
  if (!id) return { error: translate(locale, 'action.apiTokenIdRequired') };
  try {
    const api = await getAuthedApiClient();
    await api.updateApiToken(id, input);
    revalidatePath('/account/settings');
    return { ok: true };
  } catch (error) {
    return {
      error: await apiErrorMessage(error, translate(locale, 'action.apiTokenUpdateFailed')),
    };
  }
}
