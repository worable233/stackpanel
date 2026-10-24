import { createPackageTranslator } from '@stackpanel/sdk';
import enUS from '../messages/en-US.json';
import zhCN from '../messages/zh-CN.json';
import zhTW from '../messages/zh-TW.json';
import zhHK from '../messages/zh-HK.json';

/**
 * Theme-local catalogs (ADR-0016 §5).
 *
 * Catalogs live outside `src/` because they are message data, not code. Keys are
 * flat and theme-local: they are never merged into the kernel catalog.
 *
 * Note the split this theme follows:
 * - *Interface copy* (navigation, buttons, article chrome) lives here.
 * - *Site content* (hero copy, feature blurbs) is a settings default, so the
 *   operator's value always wins; the Chinese default is the seed value only.
 */
export const messages = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  'zh-HK': zhHK,
  'en-US': enUS,
} as const;

export const t = (locale?: string) =>
  createPackageTranslator(locale, messages, ['zh-CN']);
