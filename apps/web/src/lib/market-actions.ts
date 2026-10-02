'use server';

import { getLocale } from '@/i18n/locale';
import { translate } from '@/i18n/core';
import { getAuthedApiClient } from './api';
import { apiErrorMessage } from './api-errors';

export interface MarketActionState {
  ok?: boolean;
  error?: string;
  message?: string;
}

/** Install or upgrade a plugin from the local application market. */
export async function installMarketPluginAction(
  _prev: MarketActionState,
  formData: FormData,
): Promise<MarketActionState> {
  const locale = await getLocale();
  const id = String(formData.get('id') ?? '');
  if (!id) return { error: translate(locale, 'action.pluginIdRequired') };
  try {
    const api = await getAuthedApiClient();
    const result = await api.installMarketPlugin(id);
    return {
      ok: true,
      message: translate(locale, result.upgraded ? 'action.pluginUpgraded' : 'action.pluginInstalled', {
        id,
        version: result.version,
      }),
    };
  } catch (err) {
    return { error: await apiErrorMessage(err, translate(locale, 'action.marketInstallFailed')) };
  }
}

/** Install or upgrade a theme from the local application market. */
export async function installMarketThemeAction(
  _prev: MarketActionState,
  formData: FormData,
): Promise<MarketActionState> {
  const locale = await getLocale();
  const id = String(formData.get('id') ?? '');
  if (!id) return { error: translate(locale, 'action.themeIdRequired') };
  try {
    const api = await getAuthedApiClient();
    const result = await api.installMarketTheme(id);
    return {
      ok: true,
      message: translate(locale, result.upgraded ? 'action.themeUpgraded' : 'action.themeInstalled', {
        id,
        version: result.version,
      }),
    };
  } catch (err) {
    return { error: await apiErrorMessage(err, translate(locale, 'action.marketInstallFailed')) };
  }
}
