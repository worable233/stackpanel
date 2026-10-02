import { describe, expect, it } from 'vitest';
import zhCN from '@/i18n/messages/zh-CN.json';
import enUS from '@/i18n/messages/en-US.json';
import { CATALOGS, DEFAULT_LOCALE, LOCALES } from '@/i18n/config';
import { lookupMessage } from '@/i18n/core';

function flatten(node: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') {
      keys.push(...flatten(value as Record<string, unknown>, path));
    } else {
      keys.push(path);
    }
  }
  return keys.sort();
}

describe('message catalogs', () => {
  it('registers a catalog for every shipped locale', () => {
    for (const locale of LOCALES) {
      expect(CATALOGS[locale]).toBeTruthy();
    }
  });

  it('keeps zh-CN and en-US key sets identical', () => {
    expect(flatten(enUS)).toEqual(flatten(zhCN));
  });

  it('has non-empty strings for every message', () => {
    for (const locale of LOCALES) {
      for (const key of flatten(CATALOGS[locale] as Record<string, unknown>)) {
        const value = lookupMessage(CATALOGS[locale], key);
        expect(value, `${locale}:${key}`).toBeTruthy();
      }
    }
  });

  it('exposes a default locale catalog used for fallback', () => {
    expect(CATALOGS[DEFAULT_LOCALE]).toBeTruthy();
  });
});
