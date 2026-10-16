import { describe, expect, it } from 'vitest';
import { decodeSegmentsSafely, isPublicAssetRequest } from '@/lib/plugin-proxy-path';
import { safeInternalPath } from '@/lib/safe-path';

/**
 * Regression tests for the BFF/proxy hardening (audit D-1) and the open
 * redirect fix (audit D-2).
 */
describe('decodeSegmentsSafely (BFF path normalisation, D-1)', () => {
  it('accepts ordinary plugin paths', () => {
    expect(decodeSegmentsSafely(['store', 'admin', 'orders'])).toEqual([
      'store',
      'admin',
      'orders',
    ]);
    expect(decodeSegmentsSafely(['catalog', 'admin', 'categories'])).toEqual([
      'catalog',
      'admin',
      'categories',
    ]);
  });

  it('rejects double-encoded traversal (%252e%252e → %2e%2e → ..)', () => {
    // Next decodes once, leaving `%2e%2e`; a naive `=== '..'` check misses it.
    expect(
      decodeSegmentsSafely([
        'themes',
        'default',
        'assets',
        '%252e%252e',
        '%252e%252e',
        'admin',
        'users',
      ]),
    ).toBeNull();
    expect(decodeSegmentsSafely(['themes', 'default', 'assets', '%2e%2e', 'admin'])).toBeNull();
  });

  it('rejects literal traversal, empty, and separator-smuggling segments', () => {
    expect(decodeSegmentsSafely(['a', '..', 'b'])).toBeNull();
    expect(decodeSegmentsSafely(['a', '.', 'b'])).toBeNull();
    expect(decodeSegmentsSafely(['a', '', 'b'])).toBeNull();
    expect(decodeSegmentsSafely(['a%2fb', 'c'])).toBeNull();
    expect(decodeSegmentsSafely(['a%5cb', 'c'])).toBeNull();
  });

  it('rejects malformed percent-encoding instead of throwing', () => {
    expect(decodeSegmentsSafely(['%E0%A4%A'])).toBeNull();
  });
});

describe('isPublicAssetRequest (frontend asset transport, PLAN §6.6)', () => {
  it('allows compiled frontend assets for themes and plugins without a session', () => {
    expect(
      isPublicAssetRequest('GET', ['themes', 'default', 'frontend', 'abc123', 'dist', 'index.js']),
    ).toBe(true);
    expect(isPublicAssetRequest('GET', ['plugins', 'store', 'frontend', 'dist', 'index.js'])).toBe(
      true,
    );
    expect(
      isPublicAssetRequest('GET', ['plugins', 'store', 'frontend', 'abc123', 'admin.js']),
    ).toBe(true);
    // Existing public surfaces stay open.
    expect(isPublicAssetRequest('GET', ['themes', 'default', 'theme.css'])).toBe(true);
    expect(isPublicAssetRequest('GET', ['themes', 'default', 'assets', 'logo.svg'])).toBe(true);
    expect(isPublicAssetRequest('GET', ['platform', 'brand', 'logo'])).toBe(true);
  });

  it('keeps mutations and unrelated paths behind the authenticated check', () => {
    expect(isPublicAssetRequest('POST', ['plugins', 'store', 'frontend', 'dist', 'index.js'])).toBe(
      false,
    );
    expect(isPublicAssetRequest('GET', ['plugins', 'store', 'admin', 'orders'])).toBe(false);
    expect(isPublicAssetRequest('GET', ['themes', 'default', 'settings'])).toBe(false);
    expect(isPublicAssetRequest('GET', ['plugins', 'store', 'frontend'])).toBe(false);
  });

  it('rejects traversal and malformed frontend asset requests', () => {
    expect(
      isPublicAssetRequest('GET', ['themes', 'default', 'frontend', '..', '..', 'package.json']),
    ).toBe(false);
    expect(isPublicAssetRequest('GET', ['plugins', 'store', 'frontend', '..', 'secret'])).toBe(
      false,
    );
    expect(isPublicAssetRequest('GET', ['plugins', 'BAD!', 'frontend', 'dist', 'index.js'])).toBe(
      false,
    );
  });
});

describe('safeInternalPath (open redirect, D-2)', () => {
  it('accepts same-origin relative paths and keeps query/hash', () => {
    expect(safeInternalPath('/account/orders?page=2#top')).toBe('/account/orders?page=2#top');
    expect(safeInternalPath('/login')).toBe('/login');
  });

  it('rejects the backslash bypass (browsers normalise \\ to /)', () => {
    expect(safeInternalPath('/\\evil.com')).toBeNull();
    expect(safeInternalPath('\\/evil.com')).toBeNull();
    expect(safeInternalPath('/\\/evil.com')).toBeNull();
  });

  it('rejects scheme-relative and absolute URLs', () => {
    expect(safeInternalPath('//evil.com')).toBeNull();
    expect(safeInternalPath('https://evil.com')).toBeNull();
    expect(safeInternalPath('javascript:alert(1)')).toBeNull();
  });

  it('rejects non-strings and empty values', () => {
    expect(safeInternalPath(null)).toBeNull();
    expect(safeInternalPath(undefined)).toBeNull();
    expect(safeInternalPath(42)).toBeNull();
    expect(safeInternalPath('')).toBeNull();
  });
});
