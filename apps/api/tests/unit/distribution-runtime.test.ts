import { describe, expect, it } from 'vitest';
import {
  distributionStateDir,
  getCatalogRefresh,
  resetCatalogRefreshForTest,
} from '../../src/distribution/runtime.ts';

describe('distribution runtime wiring', () => {
  it('places catalog state under <data>/distribution', () => {
    expect(distributionStateDir()).toMatch(/[/\\]distribution$/);
  });

  it('stays fully offline when no catalog repository is configured', () => {
    // The distribution unit env is hermetic and sets no DISTRIBUTION_CATALOG_REPOSITORY,
    // so a self-hosted instance must not create a refresher (and never dial GitHub).
    resetCatalogRefreshForTest();
    expect(getCatalogRefresh()).toBeNull();
    // Idempotent: repeated lookups stay null and never throw.
    expect(getCatalogRefresh()).toBeNull();
  });
});
