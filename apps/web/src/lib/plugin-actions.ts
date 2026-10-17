'use server';

import { getAuthedApiClient } from './api';
import { getSessionToken } from './auth';
import { getLocale } from '@/i18n/locale';
import { translate } from '@/i18n/core';

export interface PluginActionState {
  error?: string;
  ok?: boolean;
  message?: string;
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
    // 运行期装载：安装成功后前端产物即时生效，直接返回成功。
    return { ok: true, message: translate(locale, 'plugin.installed') };
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
