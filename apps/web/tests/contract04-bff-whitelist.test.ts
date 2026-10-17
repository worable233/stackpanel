import { describe, expect, it } from 'vitest';
import { isPublicAssetRequest } from '@/lib/plugin-proxy-path';

/**
 * Contract 04 §5/§6 + contract 05 §4: the BFF public-asset whitelist.
 *
 * Compiled frontend assets (JS/CSS/maps/fonts) must be fetchable without a
 * session, both unversioned (`<kind>/<id>/frontend/dist/**`) and versioned
 * (`<kind>/<id>/frontend/<revision>/**`). Anything else — especially plugin
 * business routes — must NOT be treated as a public asset.
 */

describe('isPublicAssetRequest (contract 04 §5/§6)', () => {
  it('admits brand assets', () => {
    expect(isPublicAssetRequest('GET', ['platform', 'brand', 'logo'])).toBe(true);
    expect(isPublicAssetRequest('GET', ['platform', 'brand', 'favicon'])).toBe(true);
  });

  it('admits unversioned plugin/theme frontend assets', () => {
    expect(isPublicAssetRequest('GET', ['plugins', 'store', 'frontend', 'dist', 'index.js'])).toBe(
      true,
    );
    expect(isPublicAssetRequest('GET', ['themes', 'default', 'frontend', 'dist', 'index.css'])).toBe(
      true,
    );
  });

  it('admits versioned plugin/theme frontend assets', () => {
    expect(
      isPublicAssetRequest('GET', [
        'plugins',
        'store',
        'frontend',
        'abc123def456',
        'dist',
        'index.js',
      ]),
    ).toBe(true);
    expect(
      isPublicAssetRequest('GET', ['themes', 'default', 'frontend', 'abc123def456', 'dist', 'x.css']),
    ).toBe(true);
  });

  it('admits HEAD but not mutating methods', () => {
    expect(isPublicAssetRequest('HEAD', ['plugins', 'store', 'frontend', 'dist', 'i.js'])).toBe(true);
    expect(isPublicAssetRequest('POST', ['plugins', 'store', 'frontend', 'dist', 'i.js'])).toBe(
      false,
    );
  });

  it('rejects traversal and empty segments', () => {
    expect(
      isPublicAssetRequest('GET', ['plugins', 'store', 'frontend', 'dist', '..', 'secret']),
    ).toBe(false);
    expect(isPublicAssetRequest('GET', ['plugins', 'store', 'frontend', 'dist', ''])).toBe(false);
  });

  it('rejects plugins business routes and plugin-id-only paths', () => {
    expect(isPublicAssetRequest('GET', ['plugins', 'store', 'admin', 'orders'])).toBe(false);
    expect(isPublicAssetRequest('GET', ['plugins', 'store'])).toBe(false);
    expect(isPublicAssetRequest('GET', ['plugins', 'store', 'frontend'])).toBe(false);
  });

  it('keeps theme.css and theme assets public', () => {
    expect(isPublicAssetRequest('GET', ['themes', 'default', 'theme.css'])).toBe(true);
    expect(isPublicAssetRequest('GET', ['themes', 'default', 'assets', 'logo.svg'])).toBe(true);
  });

  it('rejects invalid plugin/theme ids', () => {
    expect(isPublicAssetRequest('GET', ['plugins', 'BAD ID', 'frontend', 'dist', 'i.js'])).toBe(
      false,
    );
    expect(isPublicAssetRequest('GET', ['themes', '..', 'theme.css'])).toBe(false);
  });
});
