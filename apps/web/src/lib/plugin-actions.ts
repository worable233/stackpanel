'use server';

import type { FrontendApplyStatus } from '@stackpanel/sdk';
import { getAuthedApiClient } from './api';
import { getSessionToken } from './auth';
import { getLocale } from '@/i18n/locale';
import { translate } from '@/i18n/core';

export interface PluginActionState {
  error?: string;
  ok?: boolean;
  message?: string;
  /** Present when the upload triggered a frontend rebuild; pins the progress UI. */
  requestedAt?: string;
  /** Whether a frontend rebuild was requested for this upload. */
  frontendApply?: boolean;
}

/** Server action: read the web tier's plugin-frontend rebuild/reload progress. */
export async function getFrontendApplyStatusAction(): Promise<FrontendApplyStatus | null> {
  try {
    const result = await (await getAuthedApiClient()).getFrontendApplyStatus();
    return result.status;
  } catch {
    return null;
  }
}

/** Upload one signed or development-mode plugin ZIP through the admin API. */
export async function uploadPluginAction(
  _prev: PluginActionState,
  formData: FormData,
): Promise<PluginActionState> {
  const locale = await getLocale();
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0)
    return { error: translate(locale, 'plugin.uploadSelectZip') };
  if (file.size > 2 * 1024 * 1024) return { error: translate(locale, 'plugin.zipTooLarge') };
  const token = await getSessionToken();
  const apiBase = process.env.API_BASE_URL ?? 'http://127.0.0.1:3001';
  try {
    const body = new FormData();
    body.append('file', file, file.name);
    const response = await fetch(`${apiBase}/admin/plugins/upload`, {
      method: 'POST',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body,
    });
    if (!response.ok) {
      const json = (await response.json().catch(() => null)) as { error?: string } | null;
      return {
        error:
          json?.error ?? translate(locale, 'plugin.uploadFailedStatus', { status: response.status }),
      };
    }
    const json = (await response.json().catch(() => null)) as {
      installed?: boolean;
      id?: string;
      frontendApply?: { requestedAt?: string } | null;
    } | null;
    const requestedAt = json?.frontendApply?.requestedAt;
    return {
      ok: true,
      message: requestedAt
        ? translate(locale, 'plugin.installedApplying')
        : translate(locale, 'plugin.installed'),
      frontendApply: Boolean(requestedAt),
      ...(requestedAt ? { requestedAt } : {}),
    };
  } catch {
    return { error: translate(locale, 'plugin.uploadFailed') };
  }
}

export async function togglePluginAction(formData: FormData): Promise<void> {
  const id = formData.get('id');
  const enabled = formData.get('enabled');
  if (typeof id !== 'string' || !id || (enabled !== 'true' && enabled !== 'false')) return;
  await (await getAuthedApiClient()).togglePlugin(id, enabled === 'true');
}

export async function deletePluginAction(formData: FormData): Promise<void> {
  const id = formData.get('id');
  if (typeof id !== 'string' || !id) return;
  await (await getAuthedApiClient()).deletePlugin(id);
}
