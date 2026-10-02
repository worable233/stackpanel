'use server';
import { getAuthedApiClient } from './api';
import { getSessionToken } from './auth';
import { getLocale } from '@/i18n/locale';
import { translate } from '@/i18n/core';

export interface ThemeActionState {
  error?: string;
  ok?: boolean;
}

/** Upload a theme ZIP to the API (multipart). */
export async function uploadThemeAction(
  _prev: ThemeActionState,
  formData: FormData,
): Promise<ThemeActionState> {
  const locale = await getLocale();
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { error: translate(locale, 'theme.uploadSelectZip') };
  }
  if (file.size > 2 * 1024 * 1024) {
    return { error: translate(locale, 'plugin.zipTooLarge') };
  }
  const token = await getSessionToken();
  const apiBase = process.env.API_BASE_URL ?? 'http://127.0.0.1:3001';
  try {
    const body = new FormData();
    body.append('file', file, file.name);
    const res = await fetch(`${apiBase}/admin/themes`, {
      method: 'POST',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body,
    });
    if (!res.ok) {
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      return {
        error:
          json?.error ?? translate(locale, 'theme.uploadFailedStatus', { status: res.status }),
      };
    }
    return { ok: true };
  } catch {
    return { error: translate(locale, 'theme.uploadFailed') };
  }
}

/** Activate a theme (reads `id` from the submitted form). */
export async function activateThemeAction(formData: FormData): Promise<void> {
  const id = formData.get('id');
  if (typeof id !== 'string' || id.length === 0) return;
  const api = await getAuthedApiClient();
  await api.activateTheme(id);
}

/** Set the admin theme preview without changing the active theme. */
export async function previewThemeAction(formData: FormData): Promise<void> {
  const id = formData.get('id');
  if (typeof id !== 'string' || id.length === 0) return;
  const api = await getAuthedApiClient();
  await api.setThemePreview(id);
}

/** Clear the admin theme preview and return to the active theme. */
export async function clearPreviewThemeAction(): Promise<void> {
  const api = await getAuthedApiClient();
  await api.clearThemePreview();
}

/** Delete a theme (reads `id` from the submitted form). */
export async function deleteThemeAction(formData: FormData): Promise<void> {
  const id = formData.get('id');
  if (typeof id !== 'string' || id.length === 0) return;
  const api = await getAuthedApiClient();
  await api.deleteTheme(id);
}
