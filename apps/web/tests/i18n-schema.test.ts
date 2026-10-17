import { describe, expect, it } from 'vitest';
import {
  isPackageMessageKey,
  isValidLanguageTag,
  isValidMessageKey,
  messageNamespace,
  placeholderDiff,
  placeholderNames,
  RESERVED_NAMESPACES,
} from '@/i18n/schema';

describe('isValidLanguageTag', () => {
  it('accepts well-formed BCP 47 tags', () => {
    for (const tag of ['en', 'en-US', 'zh-CN', 'pt-BR', 'sr-Latn-RS']) {
      expect(isValidLanguageTag(tag), tag).toBe(true);
    }
  });

  it('rejects malformed tags', () => {
    for (const tag of ['', 'e', 'en_US', '-en', 'en-', '123', 'zh CN']) {
      expect(isValidLanguageTag(tag), tag).toBe(false);
    }
  });
});

describe('isValidMessageKey', () => {
  it('accepts namespaced dotted ids', () => {
    for (const key of ['auth.login.title', 'error.auth.code_expired', 'plugin.store.items']) {
      expect(isValidMessageKey(key), key).toBe(true);
    }
  });

  it('rejects bare keys, leading dots and uppercase segments', () => {
    for (const key of ['title', '.auth', 'auth.', 'Auth.Login']) {
      expect(isValidMessageKey(key), key).toBe(false);
    }
  });
});

describe('messageNamespace / isPackageMessageKey', () => {
  it('extracts the first segment', () => {
    expect(messageNamespace('auth.login.title')).toBe('auth');
    expect(messageNamespace('solo')).toBe('solo');
  });

  it('reserves kernel namespaces from dynamic packages', () => {
    for (const ns of RESERVED_NAMESPACES) {
      expect(isPackageMessageKey(`${ns}.something`), ns).toBe(false);
    }
    expect(isPackageMessageKey('plugin.store.items')).toBe(true);
  });
});

describe('placeholderNames / placeholderDiff', () => {
  it('collects and sorts placeholder names', () => {
    expect(placeholderNames('{b} and {a}')).toEqual(['a', 'b']);
    expect(placeholderNames('no params')).toEqual([]);
  });

  it('ignores non-identifier braces', () => {
    expect(placeholderNames('{1} {a-b} {ok}')).toEqual(['ok']);
  });

  it('reports a diff only when the sets disagree', () => {
    expect(placeholderDiff('{a} {b}', '{b} {a}')).toBeNull();
    expect(placeholderDiff('{a}', '{b}')).toMatch(/placeholders differ/);
  });
});
