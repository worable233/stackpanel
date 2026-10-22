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
    return {
      error: await apiErrorMessage(err, translate(locale, 'action.platformInfoSaveFailed')),
    };
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

/** Change the platform settlement currency (kernel validates compatibility). */
export async function saveSettlementCurrencyAction(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const locale = await getLocale();
  const currency = formData.get('currency');
  if (typeof currency !== 'string' || !currency.trim()) {
    return { error: translate(locale, 'action.settlementCurrencyRequired') };
  }
  try {
    const api = await getAuthedApiClient();
    const result = await api.setSettlementCurrency(currency.trim());
    revalidatePath('/admin/settings');
    return {
      ok: true,
      message: translate(locale, 'action.settlementCurrencySaved', {
        currency: result.settlementCurrency,
      }),
    };
  } catch (err) {
    return {
      error: await apiErrorMessage(err, translate(locale, 'action.settlementCurrencySaveFailed')),
    };
  }
}

/** Enable or disable a catalog currency (referenced/settlement rows are refused). */
export async function setCurrencyEnabledAction(
  code: string,
  enabled: boolean,
): Promise<SettingsActionState> {
  const locale = await getLocale();
  try {
    const api = await getAuthedApiClient();
    await api.setCurrencyEnabled(code, enabled);
    revalidatePath('/admin/settings');
    return { ok: true };
  } catch (err) {
    return {
      error: await apiErrorMessage(err, translate(locale, 'action.currencyToggleFailed')),
    };
  }
}

/** Upsert a native → settlement FX rate (kernel validates catalog + direction). */
export async function saveCurrencyRateAction(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const locale = await getLocale();
  const from = formData.get('fromCurrency');
  const rateText = formData.get('rate');
  const validUntil = formData.get('validUntil');
  if (typeof from !== 'string' || !from.trim()) {
    return { error: translate(locale, 'action.currencyRateFromRequired') };
  }
  // The admin types a display rate (e.g. 7.2); the API stores it ×1e6.
  const displayRate = typeof rateText === 'string' ? Number(rateText) : Number.NaN;
  if (!Number.isFinite(displayRate) || displayRate <= 0) {
    return { error: translate(locale, 'action.currencyRateInvalid') };
  }
  try {
    const api = await getAuthedApiClient();
    await api.setCurrencyRate({
      fromCurrency: from.trim(),
      rate: Math.round(displayRate * 1_000_000),
      ...(typeof validUntil === 'string' && validUntil.trim()
        ? { validUntil: new Date(validUntil).toISOString() }
        : {}),
    });
    revalidatePath('/admin/settings');
    return { ok: true, message: translate(locale, 'action.currencyRateSaved') };
  } catch (err) {
    return {
      error: await apiErrorMessage(err, translate(locale, 'action.currencyRateSaveFailed')),
    };
  }
}

/** Remove a configured FX rate pair. */
export async function deleteCurrencyRateAction(
  fromCurrency: string,
  toCurrency: string,
): Promise<SettingsActionState> {
  const locale = await getLocale();
  try {
    const api = await getAuthedApiClient();
    await api.deleteCurrencyRate(fromCurrency, toCurrency);
    revalidatePath('/admin/settings');
    return { ok: true };
  } catch (err) {
    return {
      error: await apiErrorMessage(err, translate(locale, 'action.currencyRateDeleteFailed')),
    };
  }
}

/**
 * Save the distribution source (catalog repository / channel / ref / mirror).
 *
 * The API re-validates everything: a malformed repository or a non-HTTPS mirror
 * is rejected here rather than silently breaking updates later.
 */
export async function saveDistributionSourceAction(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const locale = await getLocale();
  const enabled = formData.get('remoteEnabled') === 'on';
  const repository = formData.get('repository');
  const channel = formData.get('channel');
  const ref = formData.get('ref');
  const mirror = formData.get('mirror');
  if (enabled && (typeof repository !== 'string' || !repository.trim())) {
    return { error: translate(locale, 'action.distributionRepositoryRequired') };
  }
  try {
    const api = await getAuthedApiClient();
    await api.setDistributionSource({
      repository: enabled && typeof repository === 'string' ? repository.trim() : null,
      ...(channel === 'stable' || channel === 'beta' ? { channel } : {}),
      ...(typeof ref === 'string' && ref.trim() ? { ref: ref.trim() } : {}),
      mirror: typeof mirror === 'string' && mirror.trim() ? mirror.trim() : null,
    });
    revalidatePath('/admin/settings');
    return { ok: true, message: translate(locale, 'action.distributionSourceSaved') };
  } catch (err) {
    return {
      error: await apiErrorMessage(err, translate(locale, 'action.distributionSourceSaveFailed')),
    };
  }
}

/** Save the catalog signing key (empty clears it and falls back to the env var). */
export async function saveCatalogKeyAction(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const locale = await getLocale();
  const publicKey = formData.get('publicKey');
  if (typeof publicKey !== 'string') {
    return { error: translate(locale, 'action.publicKeyRequired') };
  }
  const keyId = formData.get('keyId');
  try {
    const api = await getAuthedApiClient();
    await api.setCatalogPublicKey(publicKey, typeof keyId === 'string' ? keyId : undefined);
    revalidatePath('/admin/settings');
    return {
      ok: true,
      message: translate(
        locale,
        publicKey.trim() ? 'action.catalogKeySaved' : 'action.catalogKeyCleared',
      ),
    };
  } catch (err) {
    return { error: await apiErrorMessage(err, translate(locale, 'action.catalogKeySaveFailed')) };
  }
}

/** Save the read-only catalog token (encrypted at rest, never echoed back). */
export async function saveCatalogTokenAction(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const locale = await getLocale();
  const token = formData.get('token');
  if (typeof token !== 'string') {
    return { error: translate(locale, 'action.catalogTokenRequired') };
  }
  try {
    const api = await getAuthedApiClient();
    await api.setCatalogToken(token);
    revalidatePath('/admin/settings');
    return {
      ok: true,
      message: translate(
        locale,
        token.trim() ? 'action.catalogTokenSaved' : 'action.catalogTokenCleared',
      ),
    };
  } catch (err) {
    return {
      error: await apiErrorMessage(err, translate(locale, 'action.catalogTokenSaveFailed')),
    };
  }
}

/** Trigger an immediate catalog refresh so the admin can verify the config. */
export async function refreshDistributionAction(): Promise<SettingsActionState> {
  const locale = await getLocale();
  try {
    const api = await getAuthedApiClient();
    const result = await api.refreshDistribution();
    if (!result.configured) {
      return { ok: true, message: translate(locale, 'action.distributionRefreshOffline') };
    }
    if (result.available) {
      return {
        ok: true,
        message: translate(locale, 'action.distributionRefreshOk', {
          sequence: String(result.sequence ?? 0),
        }),
      };
    }
    return {
      error: translate(locale, 'action.distributionRefreshFailed', {
        message: result.failure?.message ?? '',
      }),
    };
  } catch (err) {
    return {
      error: await apiErrorMessage(
        err,
        translate(locale, 'action.distributionRefreshFailed', {
          message: '',
        }),
      ),
    };
  }
}
