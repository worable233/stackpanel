import { describe, expect, it } from 'vitest';
import {
  distributionStateDir,
  getCatalogRefresh,
  resetCatalogRefreshForTest,
} from '../../src/distribution/runtime.ts';
import { DEFAULT_CATALOG_REPOSITORY, normalizeCatalogRepository } from '../../src/config/env.ts';

describe('distribution runtime wiring', () => {
  it('places catalog state under <data>/distribution', () => {
    expect(distributionStateDir()).toMatch(/[/\\]distribution$/);
  });

  it('stays fully offline when the catalog source is explicitly disabled', () => {
    // The test env pins `DISTRIBUTION_CATALOG_REPOSITORY=off` so the suite never
    // dials GitHub; an explicitly disabled source must not build a refresher.
    resetCatalogRefreshForTest();
    expect(getCatalogRefresh()).toBeNull();
    // Idempotent: repeated lookups stay null and never throw.
    expect(getCatalogRefresh()).toBeNull();
  });
});

describe('normalizeCatalogRepository', () => {
  it('falls back to the shipped default when unset or empty', () => {
    expect(normalizeCatalogRepository(undefined)).toBe(DEFAULT_CATALOG_REPOSITORY);
    expect(normalizeCatalogRepository('')).toBe(DEFAULT_CATALOG_REPOSITORY);
    expect(normalizeCatalogRepository('   ')).toBe(DEFAULT_CATALOG_REPOSITORY);
  });

  it('accepts owner/repo and full GitHub URLs', () => {
    expect(normalizeCatalogRepository('acme/plugins')).toBe('acme/plugins');
    expect(normalizeCatalogRepository('https://github.com/acme/plugins')).toBe('acme/plugins');
    expect(normalizeCatalogRepository('https://github.com/acme/plugins.git')).toBe('acme/plugins');
    expect(normalizeCatalogRepository('https://github.com/acme/plugins/')).toBe('acme/plugins');
  });

  it('turns explicit opt-outs into a fully offline instance', () => {
    for (const value of ['off', 'OFF', 'none', 'false', '-']) {
      expect(normalizeCatalogRepository(value)).toBeUndefined();
    }
  });

  it('rejects a malformed repository instead of silently going offline', () => {
    expect(() => normalizeCatalogRepository('not a repo')).toThrow(/DISTRIBUTION_CATALOG_REPOSITORY/);
  });
});
