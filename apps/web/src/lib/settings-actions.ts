'use server';
import { ApiError, platformBrandResponseSchema } from '@stackpanel/sdk';
import type { ProblemDetails } from '@stackpanel/sdk';
import { revalidatePath } from 'next/cache';
import { getLocale } from '@/i18n/locale';
import { translate } from '@/i18n/core';
import { getAuthedApiClient } from './api';
import { apiErrorMessage, apiErrorMessageFor } from './api-errors';
import { getSessionToken } from './auth';

export interface SettingsActionState {
  error?: string;
  ok?: boolean;
  message?: string;
}

/** Save or clear the admin-managed package signing public key. */
export async function saveSigningAction(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const locale = await getLocale();
  const publicKey = formData.get('clear') === 'true' ? '' : formData.get('publicKey');
  if (typeof publicKey !== 'string') {
    return { error: translate(locale, 'action.publicKeyRequired') };
  }
  try {
    const api = await getAuthedApiClient();
    await api.setSigningPublicKey(publicKey);
    return {
      ok: true,
      message: translate(
        locale,
        publicKey.trim() ? 'action.publicKeySaved' : 'action.publicKeyCleared',
      ),
    };
  } catch (err) {
    return { error: await apiErrorMessage(err, translate(locale, 'action.publicKeySaveFailed')) };
  }
}

/** Save the platform-owned, non-secret public identity. */
export async function savePlatformInfoAction(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const locale = await getLocale();
  const name = formData.get('name');
  const description = formData.get('description');
  const url = formData.get('url');
  if (typeof name !== 'string' || typeof description !== 'string' || typeof url !== 'string') {
    return { error: translate(locale, 'action.platformInfoRequired') };
  }
  try {
    const api = await getAuthedApiClient();
    await api.updatePlatformInfo({ name, description, url: url || null });
    revalidatePath('/', 'layout');
    return { ok: true, message: translate(locale, 'action.platformInfoSaved') };
  } catch (err) {
    return { error: await apiErrorMessage(err, translate(locale, 'action.platformInfoSaveFailed')) };
  }
}

/** Upload the platform logo/favicon (multipart) and refresh brand consumers. */
export async function savePlatformBrandAction(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const locale = await getLocale();
  const logo = formData.get('logo');
  const favicon = formData.get('favicon');
  const hasLogo = logo instanceof File && logo.size > 0;
  const hasFavicon = favicon instanceof File && favicon.size > 0;
  if (!hasLogo && !hasFavicon) {
    return { error: translate(locale, 'action.brandImageRequired') };
  }
  if ((hasLogo && logo.size > 1024 * 1024) || (hasFavicon && favicon.size > 1024 * 1024)) {
    return { error: translate(locale, 'action.brandImageTooLarge') };
  }
  const token = await getSessionToken();
  const apiBase = process.env.API_BASE_URL ?? 'http://127.0.0.1:3001';
  try {
    const body = new FormData();
    if (hasLogo) body.append('logo', logo, logo.name);
    if (hasFavicon) body.append('favicon', favicon, favicon.name);
    const res = await fetch(`${apiBase}/admin/platform/brand`, {
      method: 'POST',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body,
    });
    if (!res.ok) {
      const problem = (await res.json().catch(() => null)) as Partial<ProblemDetails> | null;
      const statusFallback = translate(locale, 'action.brandImageUploadFailedStatus', {
        status: res.status,
      });
      return {
        error: apiErrorMessageFor(
          locale,
          new ApiError(problem?.detail ?? statusFallback, {
            status: res.status,
            ...(typeof problem?.code === 'string' ? { code: problem.code } : {}),
          }),
          statusFallback,
        ),
      };
    }
    revalidatePath('/', 'layout');
    return { ok: true, message: translate(locale, 'action.brandImageSaved') };
  } catch {
    return { error: translate(locale, 'action.brandImageUploadFailed') };
  }
}

/** Clear the platform logo/favicon, restoring the built-in defaults. */
export async function clearPlatformBrandAction(): Promise<SettingsActionState> {
  const locale = await getLocale();
  try {
    const api = await getAuthedApiClient();
    await api.del('/admin/platform/brand', platformBrandResponseSchema);
    revalidatePath('/', 'layout');
    return { ok: true, message: translate(locale, 'action.brandImageCleared') };
  } catch (err) {
    return { error: await apiErrorMessage(err, translate(locale, 'action.brandImageClearFailed')) };
  }
}
