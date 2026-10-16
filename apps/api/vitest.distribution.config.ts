import { defineConfig } from 'vitest/config';
// Distribution source/contract unit tests use injected fakes only; never run the DB setup.
export default defineConfig({
  test: {
    include: [
      'tests/unit/distribution-source.test.ts',
      'tests/unit/distribution-package.test.ts',
      'tests/unit/distribution-keyring.test.ts',
      'tests/unit/distribution-refresh.test.ts',
      'tests/unit/distribution-catalog-consumer.test.ts',
      'tests/unit/distribution-market.test.ts',
      'tests/unit/distribution-runtime.test.ts',
      'tests/unit/package-transaction.test.ts',
      'tests/unit/frontend-assets.test.ts',
    ],
    environment: 'node',
    // `env.ts` is parsed at import time; supply the required values so pure
    // distribution units can import config-dependent modules without a database.
    env: {
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused',
      JWT_SECRET: 'distribution_unit_test_secret_at_least_32_chars',
    },
  },
});
