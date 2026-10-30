import { createPackageTranslator } from '@stackpanel/sdk';
import enUS from '../messages/en-US.json';
import zhCN from '../messages/zh-CN.json';
import zhTW from '../messages/zh-TW.json';
import zhHK from '../messages/zh-HK.json';

/**
 * Package-local catalogs (ADR-0016 §5). Keys are flat and package-local: the
 * host never merges them into the kernel catalog.
 */
export const messages = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  'zh-HK': zhHK,
  'en-US': enUS,
} as const;

export const t = (locale?: string) => createPackageTranslator(locale, messages, ['zh-CN']);
