import { describe, expect, it } from 'vitest';
import zhCN from '@/i18n/messages/zh-CN.json';
import enUS from '@/i18n/messages/en-US.json';
import { CATALOGS, DEFAULT_LOCALE, LOCALES } from '@/i18n/config';
import { lookupMessage } from '@/i18n/core';
import {
  isValidLanguageTag,
  isValidMessageKey,
  messageNamespace,
  placeholderNames,
} from '@/i18n/schema';

function flatten(node: Record<string, unknown>, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') {
      Object.assign(out, flatten(value as Record<string, unknown>, path));
    } else if (typeof value === 'string') {
      out[path] = value;
    }
  }
  return out;
}

const zh = flatten(zhCN);
const en = flatten(enUS);

/**
 * Messages that legitimately use different placeholders per locale because the
 * two languages express the same fact differently (here: Chinese 折 vs English
 * percent). Every entry must carry a reason; anything else must match exactly.
 */
const PLACEHOLDER_EXCEPTIONS: Record<string, string> = {
  'admin.rbac.discountPercent': '中文用折数 {fold}，英文用百分比 {discount}',
};

describe('message catalogs', () => {
  it('registers a catalog for every shipped locale', () => {
    for (const locale of LOCALES) {
      expect(CATALOGS[locale]).toBeTruthy();
    }
  });

  it('keeps zh-CN and en-US key sets identical', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  });

  it('keeps every shipped locale on the same key set', () => {
    const expected = Object.keys(zh).sort();
    for (const locale of LOCALES) {
      const keys = Object.keys(flatten(CATALOGS[locale] as Record<string, unknown>)).sort();
      expect(keys, locale).toEqual(expected);
    }
  });

  it('names every shipped locale in every catalog so the picker renders', () => {
    for (const locale of LOCALES) {
      for (const target of LOCALES) {
        const key = `locale.${target}`;
        expect(lookupMessage(CATALOGS[locale], key), `${locale}:${key}`).toBeTruthy();
      }
    }
  });

  it('has non-empty strings for every message', () => {
    for (const locale of LOCALES) {
      for (const key of Object.keys(flatten(CATALOGS[locale] as Record<string, unknown>))) {
        const value = lookupMessage(CATALOGS[locale], key);
        expect(value, `${locale}:${key}`).toBeTruthy();
      }
    }
  });

  it('exposes a default locale catalog used for fallback', () => {
    expect(CATALOGS[DEFAULT_LOCALE]).toBeTruthy();
  });

  // --- schema contract (PLAN-i18n-completion §3 阶段 0) ---

  it('uses valid BCP 47 language tags for every shipped locale', () => {
    for (const locale of LOCALES) expect(isValidLanguageTag(locale), locale).toBe(true);
  });

  it('uses dotted, namespaced message ids', () => {
    for (const key of Object.keys(zh)) {
      expect(isValidMessageKey(key), key).toBe(true);
      expect(messageNamespace(key)).toBeTruthy();
    }
  });

  it('keeps placeholder sets identical across locales (documented exceptions only)', () => {
    for (const locale of LOCALES) {
      const catalog = flatten(CATALOGS[locale] as Record<string, unknown>);
      for (const key of Object.keys(zh)) {
        if (key in PLACEHOLDER_EXCEPTIONS) continue;
        expect(placeholderNames(catalog[key] ?? ''), `${locale}:${key}`).toEqual(
          placeholderNames(zh[key]!),
        );
      }
    }
  });

  it('documents every placeholder-parity exception with a reason', () => {
    for (const [key, reason] of Object.entries(PLACEHOLDER_EXCEPTIONS)) {
      expect(zh[key], key).toBeTruthy();
      expect(en[key], key).toBeTruthy();
      expect(reason.length, key).toBeGreaterThan(0);
      // Prove the exception is actually needed (placeholders really differ).
      expect(placeholderNames(zh[key]!)).not.toEqual(placeholderNames(en[key]!));
    }
  });
});
