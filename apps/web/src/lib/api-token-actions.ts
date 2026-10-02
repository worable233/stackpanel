'use server';
import { revalidatePath } from 'next/cache';
import { getLocale } from '@/i18n/locale';
import { translate } from '@/i18n/core';
import { getAuthedApiClient } from './api';
import { apiErrorMessage } from './api-errors';

/** Server actions for the account-center API token page (session stays server-side). */

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
}): Promise<CreateApiTokenResult> {
  const locale = await getLocale();
  if (!input.name?.trim()) return { error: translate(locale, 'action.apiTokenNameRequired') };
  try {
    const api = await getAuthedApiClient();
    const result = await api.createApiToken({ name: input.name.trim(), scopes: input.scopes });
    revalidatePath('/account/api-keys');
    return { ok: true, token: result.token, id: result.apiToken.id };
  } catch (error) {
    return { error: await apiErrorMessage(error, translate(locale, 'action.apiTokenCreateFailed')) };
  }
}

export async function revokeApiTokenAction(id: string): Promise<ApiTokenActionResult> {
  const locale = await getLocale();
  if (!id) return { error: translate(locale, 'action.apiTokenIdRequired') };
  try {
    const api = await getAuthedApiClient();
    await api.revokeApiToken(id);
    revalidatePath('/account/api-keys');
    return { ok: true };
  } catch (error) {
    return { error: await apiErrorMessage(error, translate(locale, 'action.apiTokenRevokeFailed')) };
  }
}

export async function updateApiTokenAction(
  id: string,
  input: { name?: string; scopes?: string[]; status?: 'ACTIVE' | 'DISABLED' },
): Promise<ApiTokenActionResult> {
  const locale = await getLocale();
  if (!id) return { error: translate(locale, 'action.apiTokenIdRequired') };
  try {
    const api = await getAuthedApiClient();
    await api.updateApiToken(id, input);
    revalidatePath('/account/api-keys');
    return { ok: true };
  } catch (error) {
    return { error: await apiErrorMessage(error, translate(locale, 'action.apiTokenUpdateFailed')) };
  }
}
