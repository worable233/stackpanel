'use server';

import type { FrontendSettings } from '@stackpanel/sdk';
import { z } from 'zod';
import { themeSettingsSchema } from './theme-configuration';
import { revalidatePath } from 'next/cache';
import { getLocale } from '@/i18n/locale';
import { translate } from '@/i18n/core';
import { getAuthedApiClient } from './api';
import { apiErrorMessage } from './api-errors';

export interface FrontendSettingsActionState {
  ok?: boolean;
  error?: string;
}

/** Save a theme's frontend settings through the admin API. */
export async function saveThemeSettingsAction(
  id: string,
  settings: FrontendSettings,
  expectedVersion?: string,
): Promise<FrontendSettingsActionState> {
  try {
    const api = await getAuthedApiClient();
    await api.updateThemeSettings(id, settings, expectedVersion);
    revalidatePath('/', 'layout');
    return { ok: true };
  } catch (err) {
    const locale = await getLocale();
    return { error: await apiErrorMessage(err, translate(locale, 'action.settingsSaveFailed')) };
  }
}

export async function validateThemeSettingsAction(
  id: string,
  settings: FrontendSettings,
): Promise<{ ok?: boolean; error?: string }> {
  try {
    const api = await getAuthedApiClient();
    await api.post(`/admin/themes/${encodeURIComponent(id)}/configuration/validate`, { settings }, z.object({ valid: z.literal(true), settings: z.record(z.string(), z.unknown()) }));
    return { ok: true };
  } catch (err) {
    const locale = await getLocale();
    return { error: await apiErrorMessage(err, translate(locale, 'action.settingsSaveFailed')) };
  }
}

export async function saveThemeConfigurationAction(
  id: string,
  settings: FrontendSettings,
  expectedVersion: string,
): Promise<{ version?: string; error?: string }> {
  try {
    const api = await getAuthedApiClient();
    const result = await api.patch(`/admin/themes/${encodeURIComponent(id)}/configuration`, { settings, expectedVersion }, z.object({ settings: themeSettingsSchema, version: z.string() }));
    revalidatePath('/', 'layout');
    return { version: result.version };
  } catch (error) {
    return { error: await apiErrorMessage(error) };
  }
}

/** Save a plugin's frontend settings through the admin API. */
export async function savePluginSettingsAction(
  id: string,
  settings: FrontendSettings,
): Promise<FrontendSettingsActionState> {
  try {
    const api = await getAuthedApiClient();
    await api.updatePluginSettings(id, settings);
    return { ok: true };
  } catch (err) {
    const locale = await getLocale();
    return { error: await apiErrorMessage(err, translate(locale, 'action.settingsSaveFailed')) };
  }
}

/** Store a short-lived, per-admin draft. Public theme settings are untouched. */
export async function previewThemeSettingsAction(id: string, settings: FrontendSettings): Promise<FrontendSettingsActionState> {
  try {
    const api = await getAuthedApiClient();
    await api.post(`/admin/themes/${encodeURIComponent(id)}/configuration/preview`, { settings }, z.object({ ok: z.boolean() }));
    return { ok: true };
  } catch (error) { return { error: await apiErrorMessage(error) }; }
}
