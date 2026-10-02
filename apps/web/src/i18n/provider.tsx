'use client';

import { createContext, useContext, useMemo } from 'react';
import { createTranslator, type Translator } from './core';
import type { Locale } from './config';

interface I18nContextValue {
  locale: Locale;
  t: Translator;
}

const I18nContext = createContext<I18nContextValue | null>(null);

/**
 * Client-side i18n context (ADR-0016).
 *
 * The server resolves the locale and passes only the string; the translator is
 * rebuilt on the client from the shipped catalogs, so nothing nonserialisable
 * crosses the boundary. Client components read it with `useTranslator`.
 */
export function I18nProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  const value = useMemo<I18nContextValue>(
    () => ({ locale, t: createTranslator(locale) }),
    [locale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used within <I18nProvider>');
  return value;
}

/** Current interface locale, for client components that need it directly. */
export function useLocale(): Locale {
  return useI18n().locale;
}

/** Translator for the current interface locale. */
export function useTranslator(): Translator {
  return useI18n().t;
}
