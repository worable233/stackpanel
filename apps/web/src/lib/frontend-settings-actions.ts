'use server';

import type { FrontendSettings } from '@stackpanel/sdk';
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
): Promise<FrontendSettingsActionState> {
  try {
    const api = await getAuthedApiClient();
    await api.updateThemeSettings(id, settings);
    return { ok: true };
  } catch (err) {
    const locale = await getLocale();
    return { error: await apiErrorMessage(err, translate(locale, 'action.settingsSaveFailed')) };
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
