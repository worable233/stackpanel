import { createPackageTranslator } from '@stackpanel/sdk';
import enUS from '../messages/en-US.json';
import zhCN from '../messages/zh-CN.json';

/**
 * Package-local catalogs (ADR-0016 §5).
 *
 * Catalogs live outside `src/` because they are message data, not code. Keys are
 * flat and package-local: they are never merged into the kernel catalog, so a
 * package cannot shadow platform copy.
 *
 * `messages` is also exported on the package object so the build can serialize
 * it into the manifest, letting the host resolve nav/system-settings labels
 * without importing the module graph.
 */
export const messages = { 'zh-CN': zhCN, 'en-US': enUS } as const;

export const t = (locale?: string) =>
  createPackageTranslator(locale, messages, ['zh-CN']);
