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
    // No persisted market source means a self-hosted instance stays offline.
    resetCatalogRefreshForTest();
    expect(getCatalogRefresh()).toBeNull();
    // Idempotent: repeated lookups stay null and never throw.
    expect(getCatalogRefresh()).toBeNull();
  });
});
