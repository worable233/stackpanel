import { describe, expect, it } from 'vitest';
import {
  frontendAssetCacheControl,
  frontendAssetContentType,
  frontendAssetEtag,
  isAllowedFrontendAsset,
  IMMUTABLE_CACHE_CONTROL,
  REVALIDATE_CACHE_CONTROL,
  resolveFrontendAsset,
} from '../../src/lib/frontend-assets.ts';
import type { FrontendManifest } from '@stackpanel/sdk';

function manifest(overrides: Partial<FrontendManifest> = {}): FrontendManifest {
  return {
    version: '1.0.0',
    revision: 'abc123def456',
    entry: 'frontend/dist/index.js',
    pages: [],
    layouts: [],
    finders: [],
    adminRoutes: [],
    adminActions: [],
    actions: [],
    accountRoutes: [],
    accountWidgets: [],
    files: ['frontend/dist/index.js', 'frontend/dist/admin.js', 'frontend/dist/index.js.map'],
    ...overrides,
  };
}

describe('resolveFrontendAsset', () => {
  it('resolves a versioned path when the head equals the manifest revision', () => {
    const result = resolveFrontendAsset(manifest(), 'abc123def456/dist/index.js');
    expect(result).toEqual({
      ok: true,
      value: { revision: 'abc123def456', asset: 'dist/index.js' },
    });
  });

  it('resolves a legacy path when there is no revision head', () => {
    const result = resolveFrontendAsset(manifest(), 'dist/index.js');
    expect(result).toEqual({ ok: true, value: { revision: null, asset: 'dist/index.js' } });
  });

  it('rejects a stale/forged revision-shaped head instead of serving another version', () => {
    const result = resolveFrontendAsset(manifest(), 'ffffffffffff/dist/index.js');
    expect(result).toEqual({ ok: false, status: 404, reason: '前端版本不存在' });
  });

  it('rejects path traversal and empty segments', () => {
    for (const raw of ['../evil.js', 'abc123def456/../../x', 'a//b', 'a/./b', 'a\\b', '']) {
      const result = resolveFrontendAsset(manifest(), raw);
      expect(result.ok).toBe(false);
    }
  });

  it('rejects a bare revision with no asset', () => {
    const result = resolveFrontendAsset(manifest(), 'abc123def456');
    expect(result).toEqual({ ok: false, status: 400, reason: '请求参数无效' });
  });
});

describe('isAllowedFrontendAsset', () => {
  it('allows only files declared in manifest.files (frontend-relative)', () => {
    const m = manifest();
    expect(isAllowedFrontendAsset(m, 'dist/index.js')).toBe(true);
    expect(isAllowedFrontendAsset(m, 'dist/admin.js')).toBe(true);
    expect(isAllowedFrontendAsset(m, 'dist/index.js.map')).toBe(true);
    expect(isAllowedFrontendAsset(m, 'dist/secret.js')).toBe(false);
  });

  it('always allows manifest.json', () => {
    expect(isAllowedFrontendAsset(manifest(), 'manifest.json')).toBe(true);
  });

  it('matches declared files that keep the frontend/ prefix', () => {
    const m = manifest({ files: ['frontend/dist/index.js'] });
    expect(isAllowedFrontendAsset(m, 'dist/index.js')).toBe(true);
  });
});

describe('frontendAssetContentType', () => {
  it('maps js/css/json/fonts/images to correct MIME', () => {
    expect(frontendAssetContentType('dist/index.js')).toContain('text/javascript');
    expect(frontendAssetContentType('dist/index.mjs')).toContain('text/javascript');
    expect(frontendAssetContentType('styles/app.css')).toContain('text/css');
    expect(frontendAssetContentType('dist/index.js.map')).toContain('application/json');
    expect(frontendAssetContentType('manifest.json')).toContain('application/json');
    expect(frontendAssetContentType('font.woff2')).toBe('font/woff2');
    expect(frontendAssetContentType('logo.svg')).toBe('image/svg+xml');
  });
});

describe('cache contract', () => {
  it('marks versioned assets immutable and legacy assets revalidating', () => {
    expect(frontendAssetCacheControl({ revision: 'abc123', asset: 'dist/index.js' })).toBe(
      IMMUTABLE_CACHE_CONTROL,
    );
    expect(frontendAssetCacheControl({ revision: null, asset: 'dist/index.js' })).toBe(
      REVALIDATE_CACHE_CONTROL,
    );
  });

  it('binds the ETag to revision + asset so a swap changes it', () => {
    const a = frontendAssetEtag('abc123', 'dist/index.js');
    const b = frontendAssetEtag('def456', 'dist/index.js');
    expect(a).not.toBe(b);
    expect(a).toContain('abc123');
    expect(a).toContain('dist/index.js');
  });
});
